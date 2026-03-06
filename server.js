const express = require("express");
const cors = require("cors");
const path = require("path");

// Polyfill for fetch in older Node versions
if (typeof fetch === 'undefined') {
  try {
    global.fetch = require('node-fetch');
  } catch (e) {
    console.warn('[AIRCRAFT] node-fetch not available - install with: npm install node-fetch@2');
  }
}

const PORT = process.env.PORT || 3000;
// Multi-key fallback — add GNEWS_API_KEY_2 and GNEWS_API_KEY_3 as env vars for backup keys
const GNEWS_KEYS = [
  process.env.GNEWS_API_KEY,
  process.env.GNEWS_API_KEY_2,
  process.env.GNEWS_API_KEY_3,
].filter(Boolean);

if (GNEWS_KEYS.length === 0) {
  console.error("At least one GNEWS_API_KEY is required. Get a free key at https://gnews.io");
  process.exit(1);
}

// Track which key is currently active (advances on quota exhaustion)
let activeKeyIndex = 0;

// Round-robin counter — spreads requests evenly across all keys (~64 req/day each with 3 keys)
let rrIndex = 0;
const exhaustedKeys = new Set();

async function gnewsFetch(query) {
  // Try each key starting from round-robin position, skip exhausted ones
  for (let attempt = 0; attempt < GNEWS_KEYS.length; attempt++) {
    const idx = (rrIndex + attempt) % GNEWS_KEYS.length;
    if (exhaustedKeys.has(idx)) continue;
    const key = GNEWS_KEYS[idx];
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=10&token=${key}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.errors || res.status === 403 || res.status === 429) {
        const reason = data.errors?.[0] || `HTTP ${res.status}`;
        console.warn(`  [KEY ${idx + 1}/${GNEWS_KEYS.length}] Exhausted: ${reason}`);
        exhaustedKeys.add(idx);
        continue;
      }
      // Advance round-robin for next call
      rrIndex = (idx + 1) % GNEWS_KEYS.length;
      return data;
    } catch (e) {
      console.warn(`  [KEY ${idx + 1}/${GNEWS_KEYS.length}] Fetch error: ${e.message}`);
    }
  }
  console.error(`  [GNEWS] All ${GNEWS_KEYS.length} keys exhausted. Will retry after midnight UTC.`);
  return null;
}

// Reset exhausted keys at midnight UTC each day
function scheduleKeyReset() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const msUntilMidnight = midnight - now;
  setTimeout(() => {
    exhaustedKeys.clear();
    rrIndex = 0;
    console.log("  [GNEWS] Daily key reset — all keys re-enabled");
    scheduleKeyReset();
  }, msUntilMidnight);
  console.log(`  Keys reset at midnight UTC (in ${Math.round(msUntilMidnight/3600000)}h)`);
}
scheduleKeyReset();

console.log(`  Loaded ${GNEWS_KEYS.length} GNews API key(s)`);

const app = express();
app.use(cors());
app.use(express.json());
// Disable caching - force browser to always fetch fresh files
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

let cachedEvents = [];
let lastScanTime = null;
let isScanning = false;

// Location database - maps keywords to coordinates
const LOCATION_DB = {
  // === UKRAINE / RUSSIA WAR ===
  "kharkiv":{lat:49.99,lng:36.23,location:"Kharkiv, Ukraine"},"kyiv":{lat:50.45,lng:30.52,location:"Kyiv, Ukraine"},
  "odesa":{lat:46.48,lng:30.73,location:"Odesa, Ukraine"},"odessa":{lat:46.48,lng:30.73,location:"Odesa, Ukraine"},
  "zaporizhzhia":{lat:47.84,lng:35.14,location:"Zaporizhzhia, Ukraine"},"donetsk":{lat:48.0,lng:37.8,location:"Donetsk, Ukraine"},
  "luhansk":{lat:48.57,lng:39.31,location:"Luhansk, Ukraine"},"crimea":{lat:44.95,lng:34.1,location:"Crimea"},
  "dnipro":{lat:48.46,lng:35.04,location:"Dnipro, Ukraine"},"bakhmut":{lat:48.59,lng:38.0,location:"Bakhmut, Ukraine"},
  "avdiivka":{lat:48.14,lng:37.74,location:"Avdiivka, Ukraine"},"kursk":{lat:51.73,lng:36.19,location:"Kursk, Russia"},
  "kherson":{lat:46.64,lng:32.62,location:"Kherson, Ukraine"},"sumy":{lat:50.91,lng:34.8,location:"Sumy, Ukraine"},
  "mariupol":{lat:47.1,lng:37.55,location:"Mariupol, Ukraine"},"mykolaiv":{lat:46.97,lng:31.99,location:"Mykolaiv, Ukraine"},
  "pokrovsk":{lat:48.28,lng:37.18,location:"Pokrovsk, Ukraine"},"kupyansk":{lat:49.71,lng:37.62,location:"Kupyansk, Ukraine"},
  "vuhledar":{lat:47.78,lng:37.25,location:"Vuhledar, Ukraine"},"toretsk":{lat:48.4,lng:37.85,location:"Toretsk, Ukraine"},
  "ukraine":{lat:48.38,lng:31.17,location:"Ukraine"},
  "moscow":{lat:55.76,lng:37.62,location:"Moscow, Russia"},"russia":{lat:55.76,lng:37.62,location:"Russia"},
  "belgorod":{lat:50.6,lng:36.59,location:"Belgorod, Russia"},"bryansk":{lat:53.25,lng:34.37,location:"Bryansk, Russia"},
  "rostov":{lat:47.24,lng:39.72,location:"Rostov, Russia"},"sevastopol":{lat:44.62,lng:33.53,location:"Sevastopol, Crimea"},
  "black sea":{lat:43.0,lng:35.0,location:"Black Sea"},
  // === IRAN / US / ISRAEL WAR 2026 ===
  "iran":{lat:35.69,lng:51.39,location:"Iran"},"tehran":{lat:35.69,lng:51.39,location:"Tehran, Iran"},
  "bushehr":{lat:28.97,lng:50.84,location:"Bushehr, Iran"},"isfahan":{lat:32.65,lng:51.68,location:"Isfahan, Iran"},
  "shiraz":{lat:29.59,lng:52.58,location:"Shiraz, Iran"},"tabriz":{lat:38.08,lng:46.29,location:"Tabriz, Iran"},
  "mashhad":{lat:36.3,lng:59.6,location:"Mashhad, Iran"},"bandar abbas":{lat:27.19,lng:56.27,location:"Bandar Abbas, Iran"},
  "minab":{lat:27.1,lng:57.08,location:"Minab, Iran"},"kerman":{lat:30.28,lng:57.08,location:"Kerman, Iran"},
  "ahvaz":{lat:31.32,lng:48.69,location:"Ahvaz, Iran"},"irgc":{lat:35.69,lng:51.39,location:"Iran"},
  "epic fury":{lat:35.69,lng:51.39,location:"Iran"},"operation epic fury":{lat:35.69,lng:51.39,location:"Iran"},
  "israel":{lat:31.77,lng:35.21,location:"Israel"},"tel aviv":{lat:32.08,lng:34.78,location:"Tel Aviv, Israel"},
  "jerusalem":{lat:31.77,lng:35.23,location:"Jerusalem"},"haifa":{lat:32.79,lng:34.99,location:"Haifa, Israel"},
  "beit shemesh":{lat:31.75,lng:34.99,location:"Beit Shemesh, Israel"},"negev":{lat:30.85,lng:34.78,location:"Negev, Israel"},
  "west bank":{lat:31.95,lng:35.3,location:"West Bank, Palestine"},"jenin":{lat:32.46,lng:35.3,location:"Jenin, West Bank"},
  "nablus":{lat:32.22,lng:35.25,location:"Nablus, West Bank"},"ramallah":{lat:31.9,lng:35.2,location:"Ramallah, West Bank"},
  // === GAZA ===
  "gaza":{lat:31.35,lng:34.31,location:"Gaza, Palestine"},"rafah":{lat:31.28,lng:34.25,location:"Rafah, Gaza"},
  "khan younis":{lat:31.35,lng:34.3,location:"Khan Younis, Gaza"},"hamas":{lat:31.35,lng:34.31,location:"Gaza"},
  // === LEBANON / HEZBOLLAH ===
  "beirut":{lat:33.89,lng:35.5,location:"Beirut, Lebanon"},"lebanon":{lat:33.85,lng:35.86,location:"Lebanon"},
  "hezbollah":{lat:33.85,lng:35.86,location:"Lebanon"},"southern lebanon":{lat:33.27,lng:35.2,location:"Southern Lebanon"},
  "tyre":{lat:33.27,lng:35.2,location:"Tyre, Lebanon"},"sidon":{lat:33.56,lng:35.38,location:"Sidon, Lebanon"},
  // === SYRIA ===
  "syria":{lat:34.8,lng:38.99,location:"Syria"},"damascus":{lat:33.51,lng:36.29,location:"Damascus, Syria"},
  "aleppo":{lat:36.2,lng:37.15,location:"Aleppo, Syria"},"idlib":{lat:35.93,lng:36.63,location:"Idlib, Syria"},
  "deir ez-zor":{lat:35.34,lng:40.14,location:"Deir ez-Zor, Syria"},"raqqa":{lat:35.95,lng:39.01,location:"Raqqa, Syria"},
  "homs":{lat:34.73,lng:36.72,location:"Homs, Syria"},"latakia":{lat:35.52,lng:35.79,location:"Latakia, Syria"},
  // === IRAQ ===
  "iraq":{lat:33.31,lng:44.37,location:"Iraq"},"baghdad":{lat:33.31,lng:44.37,location:"Baghdad, Iraq"},
  "erbil":{lat:36.19,lng:44.01,location:"Erbil, Iraq"},"basra":{lat:30.51,lng:47.81,location:"Basra, Iraq"},
  "mosul":{lat:36.34,lng:43.12,location:"Mosul, Iraq"},"kirkuk":{lat:35.47,lng:44.39,location:"Kirkuk, Iraq"},
  "jurf":{lat:32.82,lng:44.11,location:"Jurf al-Sakhar, Iraq"},
  // === GULF STATES ===
  "bahrain":{lat:26.07,lng:50.55,location:"Bahrain"},"manama":{lat:26.23,lng:50.59,location:"Manama, Bahrain"},
  "riyadh":{lat:24.71,lng:46.67,location:"Riyadh, Saudi Arabia"},"saudi":{lat:24.71,lng:46.67,location:"Saudi Arabia"},
  "jeddah":{lat:21.54,lng:39.17,location:"Jeddah, Saudi Arabia"},
  "dubai":{lat:25.2,lng:55.27,location:"Dubai, UAE"},"abu dhabi":{lat:24.45,lng:54.65,location:"Abu Dhabi, UAE"},
  "uae":{lat:24.45,lng:54.65,location:"UAE"},"kuwait":{lat:29.38,lng:47.99,location:"Kuwait"},
  "oman":{lat:23.59,lng:58.54,location:"Oman"},"duqm":{lat:19.67,lng:57.7,location:"Duqm, Oman"},
  "doha":{lat:25.29,lng:51.53,location:"Doha, Qatar"},"qatar":{lat:25.29,lng:51.53,location:"Qatar"},
  "persian gulf":{lat:26.5,lng:51.5,location:"Persian Gulf"},
  "strait of hormuz":{lat:26.59,lng:56.28,location:"Strait of Hormuz"},
  "centcom":{lat:25.31,lng:51.43,location:"US CENTCOM, Qatar"},
  // === YEMEN / RED SEA ===
  "yemen":{lat:15.37,lng:44.19,location:"Yemen"},"houthi":{lat:15.37,lng:44.19,location:"Yemen"},
  "sanaa":{lat:15.37,lng:44.19,location:"Sanaa, Yemen"},"aden":{lat:12.78,lng:45.04,location:"Aden, Yemen"},
  "red sea":{lat:13.5,lng:42.5,location:"Red Sea"},"bab el-mandeb":{lat:12.58,lng:43.33,location:"Bab el-Mandeb Strait"},
  // === JORDAN ===
  "jordan":{lat:31.95,lng:35.93,location:"Jordan"},"amman":{lat:31.95,lng:35.93,location:"Amman, Jordan"},
  // === PAKISTAN / INDIA / KASHMIR ===
  "pakistan":{lat:33.69,lng:73.04,location:"Pakistan"},"islamabad":{lat:33.69,lng:73.04,location:"Islamabad, Pakistan"},
  "karachi":{lat:24.86,lng:67.01,location:"Karachi, Pakistan"},"lahore":{lat:31.55,lng:74.35,location:"Lahore, Pakistan"},
  "peshawar":{lat:34.01,lng:71.58,location:"Peshawar, Pakistan"},"quetta":{lat:30.18,lng:66.99,location:"Quetta, Pakistan"},
  "balochistan":{lat:28.49,lng:65.1,location:"Balochistan, Pakistan"},"waziristan":{lat:32.3,lng:69.87,location:"Waziristan, Pakistan"},
  "khyber":{lat:34.17,lng:71.15,location:"Khyber Pakhtunkhwa, Pakistan"},
  "india":{lat:28.61,lng:77.21,location:"India"},"kashmir":{lat:34.08,lng:74.8,location:"Kashmir"},
  "ladakh":{lat:34.15,lng:77.58,location:"Ladakh, India"},"jammu":{lat:32.73,lng:74.87,location:"Jammu, India"},
  "loc":{lat:34.08,lng:74.8,location:"Line of Control, Kashmir"},
  // === AFGHANISTAN ===
  "afghanistan":{lat:34.53,lng:69.17,location:"Afghanistan"},"kabul":{lat:34.53,lng:69.17,location:"Kabul, Afghanistan"},
  "kandahar":{lat:31.63,lng:65.71,location:"Kandahar, Afghanistan"},"bagram":{lat:34.95,lng:69.27,location:"Bagram, Afghanistan"},
  "jalalabad":{lat:34.43,lng:70.45,location:"Jalalabad, Afghanistan"},"helmand":{lat:31.59,lng:64.36,location:"Helmand, Afghanistan"},
  // === THAILAND / SOUTHEAST ASIA ===
  "thailand":{lat:13.76,lng:100.5,location:"Thailand"},"bangkok":{lat:13.76,lng:100.5,location:"Bangkok, Thailand"},
  "pattani":{lat:6.87,lng:101.25,location:"Pattani, Thailand"},"yala":{lat:6.54,lng:101.28,location:"Yala, Thailand"},
  "narathiwat":{lat:6.43,lng:101.82,location:"Narathiwat, Thailand"},"deep south":{lat:6.6,lng:101.4,location:"Deep South, Thailand"},
  "myanmar":{lat:19.76,lng:96.07,location:"Myanmar"},"yangon":{lat:16.87,lng:96.2,location:"Yangon, Myanmar"},
  "mandalay":{lat:21.97,lng:96.08,location:"Mandalay, Myanmar"},"sagaing":{lat:21.88,lng:95.97,location:"Sagaing, Myanmar"},
  "shan":{lat:20.79,lng:97.04,location:"Shan State, Myanmar"},"rakhine":{lat:20.15,lng:92.9,location:"Rakhine, Myanmar"},
  "kachin":{lat:25.38,lng:97.39,location:"Kachin, Myanmar"},"chin":{lat:21.56,lng:93.49,location:"Chin State, Myanmar"},
  "philippines":{lat:14.6,lng:120.98,location:"Philippines"},"mindanao":{lat:7.19,lng:125.46,location:"Mindanao, Philippines"},
  "taiwan":{lat:25.03,lng:121.57,location:"Taiwan"},"taiwan strait":{lat:24.5,lng:119.5,location:"Taiwan Strait"},
  "south china sea":{lat:12.0,lng:113.0,location:"South China Sea"},
  // === CHINA / EAST ASIA ===
  "china":{lat:39.9,lng:116.4,location:"China"},"beijing":{lat:39.9,lng:116.4,location:"Beijing, China"},
  "north korea":{lat:39.04,lng:125.76,location:"North Korea"},"pyongyang":{lat:39.04,lng:125.76,location:"Pyongyang, North Korea"},
  "south korea":{lat:37.57,lng:126.98,location:"South Korea"},"seoul":{lat:37.57,lng:126.98,location:"Seoul, South Korea"},
  "japan":{lat:35.68,lng:139.69,location:"Japan"},"okinawa":{lat:26.34,lng:127.77,location:"Okinawa, Japan"},
  // === AFRICA ===
  "sudan":{lat:15.5,lng:32.56,location:"Sudan"},"khartoum":{lat:15.5,lng:32.56,location:"Khartoum, Sudan"},
  "darfur":{lat:13.5,lng:25.0,location:"Darfur, Sudan"},"port sudan":{lat:19.62,lng:37.22,location:"Port Sudan"},
  "rsf":{lat:15.5,lng:32.56,location:"Sudan"},
  "ethiopia":{lat:9.0,lng:38.75,location:"Ethiopia"},"addis ababa":{lat:9.0,lng:38.75,location:"Addis Ababa, Ethiopia"},
  "amhara":{lat:11.6,lng:37.4,location:"Amhara, Ethiopia"},"tigray":{lat:13.5,lng:39.47,location:"Tigray, Ethiopia"},
  "somalia":{lat:2.05,lng:45.32,location:"Somalia"},"mogadishu":{lat:2.05,lng:45.32,location:"Mogadishu, Somalia"},
  "al-shabaab":{lat:2.05,lng:45.32,location:"Somalia"},
  "mali":{lat:12.64,lng:-8.0,location:"Mali"},"bamako":{lat:12.64,lng:-8.0,location:"Bamako, Mali"},
  "sahel":{lat:14.5,lng:2.0,location:"Sahel Region"},"niger":{lat:13.51,lng:2.11,location:"Niger"},
  "burkina faso":{lat:12.37,lng:-1.52,location:"Burkina Faso"},
  "congo":{lat:-4.32,lng:15.31,location:"DR Congo"},"goma":{lat:-1.68,lng:29.23,location:"Goma, DR Congo"},
  "m23":{lat:-1.68,lng:29.23,location:"DR Congo"},"kivu":{lat:-1.68,lng:29.23,location:"North Kivu, DR Congo"},
  "libya":{lat:32.9,lng:13.18,location:"Libya"},"tripoli":{lat:32.9,lng:13.18,location:"Tripoli, Libya"},
  "benghazi":{lat:32.12,lng:20.09,location:"Benghazi, Libya"},
  "mozambique":{lat:-12.97,lng:40.52,location:"Mozambique"},"cabo delgado":{lat:-12.19,lng:40.27,location:"Cabo Delgado, Mozambique"},
  "nigeria":{lat:9.06,lng:7.49,location:"Nigeria"},"boko haram":{lat:11.85,lng:13.16,location:"Borno, Nigeria"},
  "cameroon":{lat:3.87,lng:11.52,location:"Cameroon"},
  "south sudan":{lat:4.85,lng:31.58,location:"South Sudan"},"juba":{lat:4.85,lng:31.58,location:"Juba, South Sudan"},
  // === LATIN AMERICA ===
  "venezuela":{lat:10.49,lng:-66.88,location:"Venezuela"},"caracas":{lat:10.49,lng:-66.88,location:"Caracas, Venezuela"},
  "maracaibo":{lat:10.63,lng:-71.63,location:"Maracaibo, Venezuela"},
  "colombia":{lat:4.71,lng:-74.07,location:"Colombia"},"bogota":{lat:4.71,lng:-74.07,location:"Bogota, Colombia"},
  "mexico":{lat:19.43,lng:-99.13,location:"Mexico"},"sinaloa":{lat:24.81,lng:-107.39,location:"Sinaloa, Mexico"},
  "haiti":{lat:18.54,lng:-72.34,location:"Haiti"},"port-au-prince":{lat:18.54,lng:-72.34,location:"Port-au-Prince, Haiti"},
  "ecuador":{lat:-0.18,lng:-78.47,location:"Ecuador"},"guayaquil":{lat:-2.19,lng:-79.89,location:"Guayaquil, Ecuador"},
  // === EUROPE / NATO ===
  "poland":{lat:52.23,lng:21.01,location:"Poland"},"nato":{lat:50.88,lng:4.38,location:"NATO HQ, Brussels"},
  "baltic":{lat:56.95,lng:24.11,location:"Baltic Region"},"romania":{lat:44.43,lng:26.1,location:"Romania"},
  "cyprus":{lat:35.17,lng:33.36,location:"Cyprus"},
  // === USA ===
  "pentagon":{lat:38.87,lng:-77.06,location:"Pentagon, USA"},
};

function classifyEvent(title, desc) {
  const text = (title + " " + desc).toLowerCase();
  if (["airstrike","air strike","bombing","bombed","drone strike","drone attack","missile strike","missile attack","shelling","shells","artillery","bombardment"].some(w=>text.includes(w))) return "airstrike";
  if (["naval","warship","submarine","navy","maritime","vessel","carrier","fleet","coast guard","blockade","strait"].some(w=>text.includes(w))) return "naval";
  if (["crash","explosion","accident","friendly fire","malfunction","collide","collision","misfire","detonate","civilian casualt","school","hospital"].some(w=>text.includes(w))) return "incident";
  if (["deploy","troops","forces move","reinforcement","mobiliz","buildup","exercises","drill","maneuver","convoy","troop movement"].some(w=>text.includes(w))) return "movement";
  return "airstrike";
}

function extractLocation(title, desc) {
  const text = (title + " " + desc).toLowerCase();
  
  // Sort keys by length (longest first) to match multi-word locations before single words
  const keys = Object.keys(LOCATION_DB).sort((a,b) => b.length - a.length);
  
  // First pass: exact matches
  for (const key of keys) {
    if (text.includes(key)) return LOCATION_DB[key];
  }
  
  // Second pass: fuzzy matching for common variations
  // Handle country adjectives (iranian -> iran, ukrainian -> ukraine)
  const adjectives = {
    'iranian': 'iran', 'iraqi': 'iraq', 'israeli': 'israel', 'syrian': 'syria',
    'ukrainian': 'ukraine', 'russian': 'russia', 'yemeni': 'yemen',
    'lebanese': 'lebanon', 'palestinian': 'gaza', 'pakistani': 'pakistan',
    'indian': 'india', 'chinese': 'china', 'north korean': 'north korea',
    'south korean': 'south korea', 'sudanese': 'sudan', 'somali': 'somalia',
    'congolese': 'congo', 'ethiopian': 'ethiopia', 'nigerian': 'nigeria',
    'malian': 'mali', 'venezuelan': 'venezuela', 'colombian': 'colombia',
    'burmese': 'myanmar', 'taiwanese': 'taiwan', 'philippine': 'philippines',
    'afghan': 'afghanistan', 'turkish': 'turkey', 'saudi': 'riyadh',
  };
  
  for (const [adj, country] of Object.entries(adjectives)) {
    if (text.includes(adj) && LOCATION_DB[country]) {
      return LOCATION_DB[country];
    }
  }
  
  // Third pass: regional fallbacks
  const regionalFallbacks = {
    'middle east': 'iran',
    'persian gulf': 'persian gulf',
    'gulf region': 'persian gulf',
    'levant': 'lebanon',
    'sahel': 'mali',
    'horn of africa': 'somalia',
    'south china sea': 'south china sea',
    'east china sea': 'taiwan',
    'korean peninsula': 'north korea',
    'kashmir region': 'kashmir',
    'donbas': 'donetsk',
    'crimean': 'crimea',
  };
  
  for (const [region, key] of Object.entries(regionalFallbacks)) {
    if (text.includes(region) && LOCATION_DB[key]) {
      return LOCATION_DB[key];
    }
  }
  
  return null;
}

// Tier 1: Top priority — major international outlets
const TIER1_SOURCES = [
  "reuters.com", "bbc.com", "bbc.co.uk", "aljazeera.com", "apnews.com",
  "france24.com", "dw.com", "theguardian.com", "nytimes.com", "washingtonpost.com",
  "cnn.com", "timesofisrael.com", "jpost.com", "haaretz.com",
  "rt.com", "tass.com", "kyivindependent.com",
  "scmp.com", "ndtv.com", "nhk.or.jp", "dawn.com",
  "sky.com", "middleeasteye.net", "alarabiya.net", "arabnews.com",
  "stripes.com", "militarytimes.com",
];

// Tier 2: Accepted — regional & secondary outlets  
const TIER2_SOURCES = [
  "cnbc.com", "foxnews.com", "itvnews.com",
  "defense.gov", "army.mil", "janes.com",
  "ukrinform.net", "pravda.com.ua",
  "xinhuanet.com", "globaltimes.cn",
  "timesofindia.indiatimes.com", "hindustantimes.com",
  "timesnownews.com", "news18.com", "thehindu.com", "indianexpress.com",
  "japantimes.co.jp", "yna.co.kr", "koreaherald.com", "geo.tv",
  "africanews.com", "theafricareport.com",
  "lemonde.fr", "elpais.com", "corriere.it", "spiegel.de", "rte.ie",
  "dailyexcelsior.com", "irishmirror.ie", "morningstaronline.co.uk",
  "cbc.ca", "abc.net.au",
  "devdiscourse.com", "newsmax.com", "lokmattimes.com",
];

const ALL_TRUSTED = [...TIER1_SOURCES, ...TIER2_SOURCES];

// Build a map of source name keywords -> domain for fuzzy matching GNews source names
// e.g. "Reuters" -> "reuters.com", "BBC News" -> "bbc.com"
function domainFromSourceName(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\s+(news|times|post|online|wire|today|live|report|world|global|english|tv|media|digital|web|morning|breaking|daily|weekly)$/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isTrustedSource(url, sourceName) {
  const lowerUrl = (url || "").toLowerCase();
  const lowerName = (sourceName || "").toLowerCase();
  return ALL_TRUSTED.some(s => {
    const domain = s.replace(/\.(com|net|org|co\.uk|or\.jp|net\.ua|com\.ua|indiatimes\.com)$/, "");
    return lowerUrl.includes(s) || lowerName.includes(domain);
  });
}

function getSourceTier(url, sourceName) {
  const lowerUrl = (url || "").toLowerCase();
  const lowerName = (sourceName || "").toLowerCase();
  const match = (list) => list.some(s => {
    const domain = s.replace(/\.(com|net|org|co\.uk|or\.jp|net\.ua|com\.ua|indiatimes\.com)$/, "");
    return lowerUrl.includes(s) || lowerName.includes(domain);
  });
  if (match(TIER1_SOURCES)) return 1;
  if (match(TIER2_SOURCES)) return 2;
  return 99;
}

async function scanForEvents() {
  if (isScanning) return cachedEvents;
  // Don't bother scanning if all keys are known-exhausted
  if (exhaustedKeys.size >= GNEWS_KEYS.length) {
    console.log("  [SCAN] Skipped — all keys exhausted until midnight UTC");
    return cachedEvents;
  }
  isScanning = true;
  console.log(`[${new Date().toISOString()}] Scanning... (keys available: ${GNEWS_KEYS.length - exhaustedKeys.size}/${GNEWS_KEYS.length})`);

  // Expanded queries: 25 queries × 12 scans/day = 300 req/day (perfect for 3 keys)
  // More general terms catch diverse events, less Iran/Russia heavy
  const queries = [
    // === MIDDLE EAST (5 queries - reduced from 6) ===
    "Middle East military strike conflict",  // General ME
    "Iran strike attack military",  // Iran specific
    "Gaza Israel military operation",
    "Yemen Houthi attack shipping",
    "Syria Lebanon Iraq military",
    
    // === EUROPE (3 queries) ===
    "Ukraine Russia military attack frontline",
    "Eastern Europe NATO military",
    "Balkans Kosovo Serbia military",
    
    // === AFRICA (6 queries - increased coverage) ===
    "Sudan RSF military clash war",
    "Somalia al-Shabaab attack military",
    "Congo DRC M23 military fighting",
    "Ethiopia Tigray Amhara conflict",
    "Mali Burkina Faso Niger military",
    "Nigeria Boko Haram military attack",
    
    // === ASIA-PACIFIC (6 queries - increased) ===
    "Myanmar military junta airstrike",
    "Pakistan India Kashmir military border",
    "North Korea missile launch military",
    "South China Sea military Taiwan",
    "Philippines insurgency military Abu Sayyaf",
    "Afghanistan Taliban military attack",
    
    // === AMERICAS (3 queries) ===
    "Venezuela Colombia military border",
    "Haiti gang violence military intervention",
    "Mexico cartel military operation",
    
    // === GLOBAL / MULTI-REGION (2 queries) ===
    "naval warship military operation",
    "drone strike military attack airstrike",
  ];
  const allArticles = [];

  try {
    // Run ALL queries every scan — results are cached for 15 min so total daily cost stays low
    for (const q of queries) {
      const data = await gnewsFetch(q);
      if (data?.articles) allArticles.push(...data.articles);
      await new Promise(r => setTimeout(r, 300));
    }

    const seen = new Set();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const afterDedup = allArticles.filter(a => {
      const k = a.title.toLowerCase().slice(0,50);
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    const afterAge = afterDedup.filter(a => {
      const age = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      return age >= sevenDaysAgo;
    });
    const afterTrust = afterAge.filter(a => isTrustedSource(a.url, a.source?.name));
    const unique = afterTrust.sort((a, b) => getSourceTier(a.url, a.source?.name) - getSourceTier(b.url, b.source?.name));

    console.log(`  [FILTER] ${allArticles.length} scraped -> ${afterDedup.length} dedup -> ${afterAge.length} fresh (<7d) -> ${afterTrust.length} trusted`);

    const events = [];
    let droppedNoLocation = 0;
    for (const a of unique) {
      const loc = extractLocation(a.title, a.description || "");
      if (!loc) { droppedNoLocation++; continue; }

      // Debug: log what GNews gives us
      console.log(`  [ARTICLE] "${a.title.slice(0,60)}..." source="${a.source?.name}" url=${a.url?.slice(0,60)}`);

      // GNews returns article URL in a.url — use it directly
      // Some APIs wrap in google redirect, strip that if needed
      let articleUrl = a.url || "";
      if (articleUrl.includes("news.google.com") && articleUrl.includes("url=")) {
        try { articleUrl = new URL(articleUrl).searchParams.get("url") || articleUrl; } catch(e) {}
      }

      events.push({
        id: Date.now() + events.length,
        type: classifyEvent(a.title, a.description || ""),
        title: a.title.slice(0, 120),
        description: (a.description || "").slice(0, 300),
        lat: loc.lat, lng: loc.lng, location: loc.location,
        source: articleUrl, sourceName: a.source?.name || "News",
        image: a.image || "", time: a.publishedAt || new Date().toISOString(),
      });
    }

    if (events.length > 0) {
      cachedEvents = events;
      lastScanTime = new Date().toISOString();
    }
    console.log(`Done: ${events.length} events shown (${droppedNoLocation} dropped — no location match) from ${allArticles.length} total scraped`);
    return cachedEvents;
  } catch (e) {
    console.error("Scan failed:", e.message);
    return cachedEvents;
  } finally { isScanning = false; }
}

app.get("/api/scan", async (req, res) => {
  try {
    const isStale = !lastScanTime || Date.now() - new Date(lastScanTime) > 2 * 60 * 60 * 1000; // 2 hours
    if (isStale) {
      await scanForEvents();
    } else {
      const nextScan = new Date(new Date(lastScanTime).getTime() + 2 * 60 * 60 * 1000);
      const minsLeft = Math.ceil((nextScan - Date.now()) / 60000);
      console.log(`  [SCAN] Skipped — next scan in ~${minsLeft} min`);
    }
    const nextScanTime = lastScanTime ? new Date(new Date(lastScanTime).getTime() + 6 * 60 * 60 * 1000) : null;
    res.json({
      events: cachedEvents,
      lastScan: lastScanTime,
      nextScan: nextScanTime,
      eventCount: cachedEvents.length,
    });
  } catch (e) { res.status(500).json({ error: "Scan failed", events: cachedEvents }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "online", lastScan: lastScanTime, eventCount: cachedEvents.length, scanning: isScanning });
});

// === MILITARY AIRCRAFT TRACKING ===

// Aircraft type database - maps ICAO codes to aircraft info
const AIRCRAFT_DB = {
  // US Military Transports
  '4D0288': { type: 'C-17', country: 'US', category: 'transport', icon: 'c17' },
  '4D0289': { type: 'C-17', country: 'US', category: 'transport', icon: 'c17' },
  // Tankers
  '4D2070': { type: 'KC-135', country: 'US', category: 'tanker', icon: 'tanker' },
  // Reconnaissance
  '4D03CB': { type: 'RC-135', country: 'US', category: 'recon', icon: 'recon' },
  '4CA83E': { type: 'P-8', country: 'US', category: 'recon', icon: 'p8' },
};

// Military callsign patterns - helps identify military aircraft even without ICAO match
const MILITARY_CALLSIGNS = {
  'REACH': { country: 'US', type: 'Transport/Tanker' },
  'RCH': { country: 'US', type: 'Transport/Tanker' },
  'EVAC': { country: 'US', type: 'Medical Evacuation' },
  'CONVOY': { country: 'US', type: 'Convoy Escort' },
  'NATO': { country: 'NATO', type: 'NATO Aircraft' },
  'LAGR': { country: 'US', type: 'Tanker' },
  'RRR': { country: 'RU', type: 'Russian Military' },
  'RA-': { country: 'RU', type: 'Russian State' },
  'CTM': { country: 'FR', type: 'French Military' },
  'GAF': { country: 'DE', type: 'German Air Force' },
  'RAF': { country: 'GB', type: 'Royal Air Force' },
  'RCF': { country: 'FR', type: 'French Air Force' },
  'IAM': { country: 'IT', type: 'Italian Air Force' },
  'AME': { country: 'ES', type: 'Spanish Air Force' },
  'PAF': { country: 'PL', type: 'Polish Air Force' },
  'RSAF': { country: 'SA', type: 'Royal Saudi Air Force' },
  'CNV': { country: 'US', type: 'US Navy Convoy' },
};

// Country flags emoji
const FLAGS = {
  'US': '🇺🇸', 'RU': '🇷🇺', 'GB': '🇬🇧', 'FR': '🇫🇷', 'DE': '🇩🇪',
  'IT': '🇮🇹', 'ES': '🇪🇸', 'PL': '🇵🇱', 'SA': '🇸🇦', 'NATO': '🏳️',
  'TR': '🇹🇷', 'IL': '🇮🇱', 'UA': '🇺🇦', 'IN': '🇮🇳', 'CN': '🇨🇳',
  'JP': '🇯🇵', 'KR': '🇰🇷', 'AU': '🇦🇺', 'CA': '🇨🇦',
};

function identifyMilitaryAircraft(callsign, icao24) {
  // Check ICAO database first
  if (AIRCRAFT_DB[icao24?.toUpperCase()]) {
    return AIRCRAFT_DB[icao24.toUpperCase()];
  }
  
  // Check callsign patterns
  if (callsign) {
    const upper = callsign.toUpperCase();
    for (const [pattern, info] of Object.entries(MILITARY_CALLSIGNS)) {
      if (upper.includes(pattern)) {
        return {
          type: info.type,
          country: info.country,
          category: 'military',
          icon: 'military-generic'
        };
      }
    }
  }
  
  return null;
}

let cachedAircraft = [];
let lastAircraftUpdate = null;
let aircraftTrails = {}; // Store trails per aircraft

async function fetchMilitaryAircraft() {
  // Don't fetch if fetch is not available
  if (typeof fetch === 'undefined') {
    console.warn('[AIRCRAFT] Fetch not available - skipping aircraft tracking');
    return cachedAircraft;
  }
  
  try {
    console.log('[AIRCRAFT] Fetching from FlightRadar24...');
    
    // FlightRadar24 public data endpoint - zone format for global coverage
    // Using multiple zones to cover conflict regions
    const zones = [
      '25,70,30,80',   // Europe/Russia
      '15,35,35,60',   // Middle East
      '-10,-30,40,20', // Africa
      '0,70,50,150',   // Asia
    ];
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    
    const allAircraft = [];
    
    // Fetch all zones
    for (const zone of zones) {
      try {
        const response = await fetch(`https://data-live.flightradar24.com/zones/fcgi/feed.js?bounds=${zone}&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=0&air=1&vehicles=0&estimated=0&gliders=0&stats=0`, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          // FR24 returns object with aircraft IDs as keys
          for (const [id, ac] of Object.entries(data)) {
            // Skip metadata keys
            if (id === 'full_count' || id === 'version' || id === 'stats') continue;
            if (!Array.isArray(ac) || ac.length < 18) continue;
            
            allAircraft.push({ id, data: ac });
          }
        }
        
        await new Promise(r => setTimeout(r, 300)); // Rate limit between zones
      } catch (e) {
        console.warn(`[AIRCRAFT] Zone ${zone} failed:`, e.message);
      }
    }
    
    clearTimeout(timeoutId);
    
    const aircraft = [];
    
    for (const { id, data: ac } of allAircraft) {
      // FR24 format: [lat, lng, heading, alt, speed, squawk, radar, type, reg, timestamp, from, to, callsign, ...]
      const [lat, lng, heading, altitude, speed, squawk, radar, acType, registration, timestamp, origin, destination, callsign] = ac;
      
      // Skip if on ground or no position
      if (!lat || !lng || altitude === 0) continue;
      
      // Try to identify as military
      const militaryInfo = identifyMilitaryAircraft(callsign?.trim(), registration);
      if (!militaryInfo) continue;
      
      // Fetch trail data for this aircraft
      const trail = await fetchAircraftTrail(id);
      
      aircraft.push({
        icao24: registration || id,
        flightId: id,
        callsign: callsign?.trim() || 'Unknown',
        country: militaryInfo.country,
        type: militaryInfo.type,
        category: militaryInfo.category,
        icon: militaryInfo.icon,
        flag: FLAGS[militaryInfo.country] || '🏴',
        lat,
        lng,
        altitude: Math.round(altitude || 0),
        speed: Math.round(speed || 0),
        heading: Math.round(heading || 0),
        vertical_rate: 0,
        last_contact: Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) - timestamp),
        trail: trail || [], // Flight path
      });
    }
    
    cachedAircraft = aircraft;
    lastAircraftUpdate = new Date().toISOString();
    console.log(`[AIRCRAFT] Found ${aircraft.length} military aircraft with trails`);
    
    return aircraft;
  } catch (error) {
    // Don't crash on network errors - just log and return cache
    if (error.name === 'AbortError') {
      console.warn('[AIRCRAFT] Request timeout - FlightRadar24 may be slow');
    } else {
      console.warn('[AIRCRAFT] Fetch error:', error.message);
    }
    return cachedAircraft; // Return cache on error
  }
}

async function fetchAircraftTrail(flightId) {
  try {
    // FR24 trail endpoint - returns recent flight path
    const response = await fetch(`https://data-live.flightradar24.com/clickhandler/?flight=${flightId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    // Extract trail points from response
    if (data?.trail && Array.isArray(data.trail)) {
      // FR24 trail format: [lat, lng, alt, speed, timestamp, ...]
      return data.trail.map(point => ({
        lat: point.lat,
        lng: point.lng,
        alt: point.alt,
        timestamp: point.ts
      })).slice(-30); // Last 30 points (about 30-60 mins depending on update frequency)
    }
    
    return [];
  } catch (e) {
    return [];
  }
}

app.get("/api/aircraft", async (req, res) => {
  try {
    // Cache for 60 seconds to avoid hammering OpenSky
    const isFresh = lastAircraftUpdate && (Date.now() - new Date(lastAircraftUpdate) < 60000);
    
    if (!isFresh) {
      await fetchMilitaryAircraft();
    }
    
    res.json({
      aircraft: cachedAircraft,
      lastUpdate: lastAircraftUpdate,
      count: cachedAircraft.length,
    });
  } catch (e) {
    res.status(500).json({ error: 'Aircraft fetch failed', aircraft: cachedAircraft });
  }
});

// Update aircraft every 60 seconds
setInterval(fetchMilitaryAircraft, 60000);

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SIGINT - Military Event Tracker`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Using GNews API (free tier)`);
  console.log(`  Live aircraft tracking: OpenSky Network\n`);
  scanForEvents();
  fetchMilitaryAircraft(); // Initial aircraft fetch
  setInterval(scanForEvents, 2 * 60 * 60 * 1000); // every 2 hours (25 queries × 12 scans = 300 req/day)
});
