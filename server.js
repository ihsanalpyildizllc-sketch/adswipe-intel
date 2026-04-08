const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CONFIG_PATH = path.join(__dirname, "config.json");
const VAULT_PATH = path.join(__dirname, "vault.json");

function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  return { geminiApiKey: "", claudeApiKey: "" };
}
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
function loadVault() {
  try { if (fs.existsSync(VAULT_PATH)) return JSON.parse(fs.readFileSync(VAULT_PATH, "utf8")); } catch {}
  return [];
}
function saveVault(v) { fs.writeFileSync(VAULT_PATH, JSON.stringify(v, null, 2)); }

// ── Gemini helper ─────────────────────────────────────────────────
async function callGemini(apiKey, parts, maxTokens = 2000, model = "gemini-2.0-flash") {
  const fetch = require("node-fetch");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
}

// ── Config endpoints ──────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const c = loadConfig();
  res.json({ geminiKeySet: !!c.geminiApiKey, claudeKeySet: !!c.claudeApiKey });
});

app.post("/api/config", (req, res) => {
  const existing = loadConfig();
  const updated = {
    geminiApiKey: req.body.geminiApiKey || existing.geminiApiKey,
    claudeApiKey: req.body.claudeApiKey || existing.claudeApiKey,
  };
  saveConfig(updated);
  res.json({ success: true });
});

// ── Vault endpoints ───────────────────────────────────────────────
app.get("/api/vault", (req, res) => res.json(loadVault()));
app.post("/api/vault", (req, res) => {
  const vault = loadVault();
  const entry = { ...req.body, id: Date.now(), savedAt: new Date().toISOString() };
  vault.unshift(entry);
  saveVault(vault);
  res.json({ success: true, entry });
});
app.delete("/api/vault/:id", (req, res) => {
  const vault = loadVault().filter(v => String(v.id) !== req.params.id);
  saveVault(vault);
  res.json({ success: true });
});

// ── MAIN SCRAPE — Puppeteer scrapes entire brand ──────────────────
app.post("/api/scrape-brand", async (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) return res.status(400).json({ error: "searchTerm required" });

  let browser;
  try {
    const puppeteer = require("puppeteer");
    console.log(`\n[AdSwipe] Launching browser to scrape: "${searchTerm}"...`);

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });

    const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=${encodeURIComponent(searchTerm)}&search_type=keyword_unordered&media_type=all`;
    console.log(`[AdSwipe] Navigating to Ad Library...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);

    // Scroll to load all ads
    console.log(`[AdSwipe] Scrolling to load all ads...`);
    let lastCount = 0;
    let noChangeRounds = 0;
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
      const count = await page.evaluate(() => document.querySelectorAll('[data-pagelet="AdsLibraryAdCard"]').length || document.querySelectorAll("._7jvw").length || document.querySelectorAll('[class*="AdCard"]').length);
      console.log(`[AdSwipe] Scroll ${i + 1}: ${count} ads visible`);
      if (count === lastCount) { noChangeRounds++; if (noChangeRounds >= 3) break; } else { noChangeRounds = 0; }
      lastCount = count;
    }

    // Extract all ads from the page
    console.log(`[AdSwipe] Extracting ads...`);
    const ads = await page.evaluate(() => {
      const results = [];

      // Try multiple selectors for Ad Library cards
      const cardSelectors = [
        '[data-pagelet="AdsLibraryAdCard"]',
        '._7jvw',
        '[class*="x1dr75xp"]',
        '[role="article"]',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      // Fallback: find all ad containers by structure
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll("div")).filter(el => {
          const text = el.innerText || "";
          return text.includes("Started running") || text.includes("Active") || text.includes("Inactive");
        }).slice(0, 100);
      }

      cards.forEach((card, idx) => {
        try {
          // Get all text
          const allText = card.innerText || "";

          // Copy / ad body
          const copyEl = card.querySelector('[data-testid="ad-creative-body"]') ||
            card.querySelector('._4bl9') ||
            card.querySelector('[class*="text"]');
          const copy = copyEl ? copyEl.innerText : allText.split("\n").slice(0, 5).join(" ").trim();

          // Page name
          const pageNameEl = card.querySelector('[href*="/ads/library/"]') ||
            card.querySelector("strong") ||
            card.querySelector("h3");
          const pageName = pageNameEl ? pageNameEl.innerText.trim() : "";

          // Start date
          const dateMatch = allText.match(/Started running on (.+)/);
          const startDate = dateMatch ? dateMatch[1] : null;

          const isActive = allText.toLowerCase().includes("active") && !allText.toLowerCase().includes("inactive");

          // Images
          const images = Array.from(card.querySelectorAll("img"))
            .map(img => img.src)
            .filter(src => src && src.startsWith("http") && !src.includes("emoji") && !src.includes("icon") && src.includes("facebook"));

          // Videos
          const videos = Array.from(card.querySelectorAll("video"))
            .map(v => v.src || v.querySelector("source")?.src)
            .filter(Boolean);

          // Snapshot URL
          const snapshotLink = card.querySelector('a[href*="snapshot"]');
          const snapshotUrl = snapshotLink ? snapshotLink.href : null;

          // Determine type
          let type = "IMAGE";
          if (videos.length > 0) type = "VIDEO";
          else if (images.length > 1) type = "CAROUSEL";

          if (copy || pageName) {
            results.push({
              id: `ad_${idx}_${Date.now()}`,
              pageName: pageName || "Unknown page",
              copy: copy.slice(0, 500),
              type,
              imageUrl: images[0] || null,
              videoUrl: videos[0] || null,
              images,
              startDate,
              isActive,
              snapshotUrl,
            });
          }
        } catch (e) {}
      });

      return results;
    });

    await browser.close();
    console.log(`[AdSwipe] ✓ Scraped ${ads.length} ads for "${searchTerm}"`);

    res.json({ success: true, ads, count: ads.length, searchTerm });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("[AdSwipe] Scrape error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Transcribe a video URL with Gemini ───────────────────────────
app.post("/api/transcribe", async (req, res) => {
  const { videoUrl, snapshotUrl } = req.body;
  const config = loadConfig();
  if (!config.geminiApiKey) return res.status(400).json({ error: "No Gemini API key configured." });

  try {
    // Use snapshot URL via Puppeteer to get transcript if available
    let transcript = "";

    if (snapshotUrl) {
      const puppeteer = require("puppeteer");
      const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.goto(snapshotUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await sleep(2000);
      const pageText = await page.evaluate(() => document.body.innerText);
      await browser.close();

      // Ask Gemini to extract transcript from the page text
      transcript = await callGemini(config.geminiApiKey, [{
        text: `Extract the ad script/copy from this Facebook Ad Library snapshot page. Return only the actual ad text/script, nothing else:\n\n${pageText.slice(0, 3000)}`
      }], 1000);
    }

    if (!transcript && videoUrl) {
      transcript = await callGemini(config.geminiApiKey, [{
        text: `Transcribe this video ad and describe what you see. Video URL: ${videoUrl}. Provide: 1) Full word-for-word transcript 2) Visual description of key scenes`
      }], 1500);
    }

    res.json({ success: true, transcript });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rewrite script with Claude ────────────────────────────────────
app.post("/api/rewrite", async (req, res) => {
  const { originalCopy, product, angle } = req.body;
  const config = loadConfig();

  const PRODUCTS = {
    "exxtra-oregano": "EXXTRA Oil of Oregano with Black Seed Oil (500mg, 85% carvacrol, wild Mediterranean harvest, 730-day harvest cycle)",
    "exxtra-relief": "EXXTRA Miracle Relief Cream (16-ingredient topical for neuropathy/nerve pain, 45+ demographic)",
  };
  const ANGLES = {
    "antibiotic": "Antibiotic Cycle Breaker — biofilm penetration, gut microbiome restoration after antibiotic use",
    "parasite": "Parasite Cleanse — 21-day protocol, carvacrol as natural antiparasitic, gut rebalancing",
    "gut": "Gut Health / SIBO — dysbiosis correction, bloating, gut lining repair",
    "immune": "Immune Defense — natural antimicrobial, respiratory health",
    "candida": "Mold / Candida / Brain Fog — antifungal properties, cognitive clarity",
    "skin": "Skin From Inside — acne, eczema, gut-skin axis",
    "allergy": "Allergy Season — anti-inflammatory, histamine regulation",
    "pain": "Nerve Pain / Neuropathy — topical relief, anti-inflammatory",
    "wound": "Wounded Warrior — veteran demographic, chronic pain, natural alternative to pharmaceuticals",
  };

  const prompt = `You are an expert direct-response copywriter for supplement brands.

Product: ${PRODUCTS[product] || product}
Marketing angle: ${ANGLES[angle] || angle}

Original competitor ad copy:
"${originalCopy}"

Rewrite this ad script for our product using the specified angle. Keep the same emotional structure and hooks but adapt everything to our brand. Make it punchy, direct-response, conversion-focused. Same approximate length. Do not reference the competitor. Output only the rewritten script.`;

  try {
    if (config.claudeApiKey) {
      const fetch = require("node-fetch");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.claudeApiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      if (d.content?.[0]?.text) return res.json({ success: true, rewrite: d.content[0].text });
    }

    if (config.geminiApiKey) {
      const text = await callGemini(config.geminiApiKey, [{ text: prompt }], 1000);
      return res.json({ success: true, rewrite: text });
    }

    res.status(400).json({ error: "No API keys configured. Add Claude or Gemini key in Settings." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze ad angles ─────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { copy } = req.body;
  const config = loadConfig();
  if (!config.claudeApiKey && !config.geminiApiKey) return res.status(400).json({ error: "No API keys configured." });

  const prompt = `Analyze this ad copy as a direct-response marketing expert. Be brief and actionable.

Ad copy: "${copy}"

Provide:
1. HOOK TYPE (fear/curiosity/story/social proof/etc)
2. PERSUASION FRAMEWORK used
3. EMOTIONAL TRIGGERS
4. TARGET AVATAR
5. SWIPE RATING (1-10) with reason
6. TOP 3 TAKEAWAYS to steal`;

  try {
    if (config.claudeApiKey) {
      const fetch = require("node-fetch");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.claudeApiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      if (d.content?.[0]?.text) return res.json({ success: true, analysis: d.content[0].text });
    }
    const text = await callGemini(config.geminiApiKey, [{ text: prompt }], 1000);
    res.json({ success: true, analysis: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(3000, () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║       🔍 AdSwipe Intel is running            ║");
  console.log("║   Open: http://localhost:3000                ║");
  console.log("║   Settings → add Gemini + Claude API keys    ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
