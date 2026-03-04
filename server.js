const express = require("express");
const cors = require("cors");
const path = require("path");

const PORT = process.env.PORT || 3000;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;

if (!GNEWS_API_KEY) {
  console.error("GNEWS_API_KEY is required. Get a free key at https://gnews.io");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let cachedEvents = [];
let lastScanTime = null;
let isScanning = false;

// Location database - maps keywords to coordinates
const LOCATION_DB = {
  "kharkiv":{lat:49.99,lng:36.23,location:"Kharkiv, Ukraine"},"kyiv":{lat:50.45,lng:30.52,location:"Kyiv, Ukraine"},
  "odesa":{lat:46.48,lng:30.73,location:"Odesa, Ukraine"},"odessa":{lat:46.48,lng:30.73,location:"Odesa, Ukraine"},
  "zaporizhzhia":{lat:47.84,lng:35.14,location:"Zaporizhzhia, Ukraine"},"donetsk":{lat:48.0,lng:37.8,location:"Donetsk, Ukraine"},
  "luhansk":{lat:48.57,lng:39.31,location:"Luhansk, Ukraine"},"crimea":{lat:44.95,lng:34.1,location:"Crimea"},
  "dnipro":{lat:48.46,lng:35.04,location:"Dnipro, Ukraine"},"bakhmut":{lat:48.59,lng:38.0,location:"Bakhmut, Ukraine"},
  "kursk":{lat:51.73,lng:36.19,location:"Kursk, Russia"},"ukraine":{lat:48.38,lng:31.17,location:"Ukraine"},
  "gaza":{lat:31.35,lng:34.31,location:"Gaza, Palestine"},"rafah":{lat:31.28,lng:34.25,location:"Rafah, Gaza"},
  "tel aviv":{lat:32.08,lng:34.78,location:"Tel Aviv, Israel"},"israel":{lat:31.77,lng:35.21,location:"Israel"},
  "jerusalem":{lat:31.77,lng:35.23,location:"Jerusalem"},"beirut":{lat:33.89,lng:35.5,location:"Beirut, Lebanon"},
  "lebanon":{lat:33.85,lng:35.86,location:"Lebanon"},"hezbollah":{lat:33.85,lng:35.86,location:"Lebanon"},
  "syria":{lat:34.8,lng:38.99,location:"Syria"},"damascus":{lat:33.51,lng:36.29,location:"Damascus, Syria"},
  "aleppo":{lat:36.2,lng:37.15,location:"Aleppo, Syria"},"iran":{lat:35.69,lng:51.39,location:"Iran"},
  "tehran":{lat:35.69,lng:51.39,location:"Tehran, Iran"},"iraq":{lat:33.31,lng:44.37,location:"Iraq"},
  "baghdad":{lat:33.31,lng:44.37,location:"Baghdad, Iraq"},"yemen":{lat:15.37,lng:44.19,location:"Yemen"},
  "houthi":{lat:15.37,lng:44.19,location:"Yemen"},"red sea":{lat:13.5,lng:42.5,location:"Red Sea"},
  "saudi":{lat:24.71,lng:46.67,location:"Saudi Arabia"},"persian gulf":{lat:26.5,lng:51.5,location:"Persian Gulf"},
  "strait of hormuz":{lat:26.59,lng:56.28,location:"Strait of Hormuz"},
  "dubai":{lat:25.2,lng:55.27,location:"Dubai, UAE"},"kuwait":{lat:29.38,lng:47.99,location:"Kuwait"},
  "sudan":{lat:15.5,lng:32.56,location:"Sudan"},"khartoum":{lat:15.5,lng:32.56,location:"Khartoum, Sudan"},
  "ethiopia":{lat:9.0,lng:38.75,location:"Ethiopia"},"somalia":{lat:2.05,lng:45.32,location:"Somalia"},
  "mogadishu":{lat:2.05,lng:45.32,location:"Mogadishu, Somalia"},"mali":{lat:12.64,lng:-8.0,location:"Mali"},
  "sahel":{lat:14.5,lng:2.0,location:"Sahel Region"},"niger":{lat:13.51,lng:2.11,location:"Niger"},
  "burkina faso":{lat:12.37,lng:-1.52,location:"Burkina Faso"},"congo":{lat:-4.32,lng:15.31,location:"DR Congo"},
  "libya":{lat:32.9,lng:13.18,location:"Libya"},"mozambique":{lat:-12.97,lng:40.52,location:"Mozambique"},
  "nigeria":{lat:9.06,lng:7.49,location:"Nigeria"},"taiwan":{lat:25.03,lng:121.57,location:"Taiwan"},
  "taiwan strait":{lat:24.5,lng:119.5,location:"Taiwan Strait"},"south china sea":{lat:12.0,lng:113.0,location:"South China Sea"},
  "china":{lat:39.9,lng:116.4,location:"China"},"north korea":{lat:39.04,lng:125.76,location:"North Korea"},
  "pyongyang":{lat:39.04,lng:125.76,location:"Pyongyang, North Korea"},"myanmar":{lat:19.76,lng:96.07,location:"Myanmar"},
  "kashmir":{lat:34.08,lng:74.8,location:"Kashmir"},"ladakh":{lat:34.15,lng:77.58,location:"Ladakh, India"},
  "afghanistan":{lat:34.53,lng:69.17,location:"Afghanistan"},"kabul":{lat:34.53,lng:69.17,location:"Kabul, Afghanistan"},
  "pakistan":{lat:33.69,lng:73.04,location:"Pakistan"},"philippines":{lat:14.6,lng:120.98,location:"Philippines"},
  "poland":{lat:52.23,lng:21.01,location:"Poland"},"nato":{lat:50.88,lng:4.38,location:"NATO HQ, Brussels"},
  "baltic":{lat:56.95,lng:24.11,location:"Baltic Region"},"romania":{lat:44.43,lng:26.1,location:"Romania"},
  "black sea":{lat:43.0,lng:35.0,location:"Black Sea"},"venezuela":{lat:10.49,lng:-66.88,location:"Venezuela"},
  "pentagon":{lat:38.87,lng:-77.06,location:"Pentagon, USA"},"moscow":{lat:55.76,lng:37.62,location:"Moscow, Russia"},
  "russia":{lat:55.76,lng:37.62,location:"Russia"},"cyprus":{lat:35.17,lng:33.36,location:"Cyprus"},
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
  const keys = Object.keys(LOCATION_DB).sort((a,b) => b.length - a.length);
  for (const key of keys) { if (text.includes(key)) return LOCATION_DB[key]; }
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

function isTrustedSource(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return ALL_TRUSTED.some(s => lower.includes(s));
}

function getSourceTier(url) {
  if (!url) return 99;
  const lower = url.toLowerCase();
  if (TIER1_SOURCES.some(s => lower.includes(s))) return 1;
  if (TIER2_SOURCES.some(s => lower.includes(s))) return 2;
  return 99;
}

async function scanForEvents() {
  if (isScanning) return cachedEvents;
  isScanning = true;
  console.log(`[${new Date().toISOString()}] Scanning...`);

  const queries = ["military airstrike","military troops deployment","missile strike attack","military accident crash","naval warship incident","armed conflict combat"];
  const allArticles = [];

  try {
    // Run 3 queries per scan, rotate over time
    const idx = Math.floor(Date.now() / 900000) % queries.length;
    const batch = [queries[idx], queries[(idx+1)%queries.length], queries[(idx+2)%queries.length]];

    for (const q of batch) {
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=10&token=${GNEWS_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.articles) allArticles.push(...data.articles);
      } catch (e) { console.warn(`Query "${q}" failed:`, e.message); }
      await new Promise(r => setTimeout(r, 500));
    }

    const seen = new Set();
    const unique = allArticles.filter(a => {
      const k = a.title.toLowerCase().slice(0,50);
      if (seen.has(k)) return false; seen.add(k); return true;
    }).filter(a => isTrustedSource(a.url))
      .sort((a, b) => getSourceTier(a.url) - getSourceTier(b.url));

    const events = [];
    for (const a of unique) {
      const loc = extractLocation(a.title, a.description || "");
      if (!loc) continue;

      // Debug: log what GNews gives us
      console.log(`  [ARTICLE] "${a.title.slice(0,60)}..." => ${a.url}`);

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
    console.log(`Done: ${events.length} events from ${unique.length} trusted articles (${allArticles.length} total scraped)`);
    return cachedEvents;
  } catch (e) {
    console.error("Scan failed:", e.message);
    return cachedEvents;
  } finally { isScanning = false; }
}

app.get("/api/scan", async (req, res) => {
  try {
    const isStale = !lastScanTime || Date.now() - new Date(lastScanTime) > 60000;
    if (isStale) await scanForEvents();
    res.json({ events: cachedEvents, lastScan: lastScanTime, eventCount: cachedEvents.length });
  } catch (e) { res.status(500).json({ error: "Scan failed", events: cachedEvents }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "online", lastScan: lastScanTime, eventCount: cachedEvents.length, scanning: isScanning });
});

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => {
  console.log(`\n  SIGINT - Military Event Tracker`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Using GNews API (free tier)\n`);
  scanForEvents();
  setInterval(scanForEvents, 15 * 60 * 1000); // every 15 min
});
