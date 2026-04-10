const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

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

async function callGemini(apiKey, parts, maxTokens = 2000) {
  const fetch = require("node-fetch");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
}

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
app.post("/api/vault/update", (req, res) => {
  const vault = loadVault();
  const idx = vault.findIndex(v => String(v.id) === String(req.body.id));
  if (idx > -1) vault[idx] = { ...vault[idx], ...req.body };
  saveVault(vault);
  res.json({ success: true });
});

// ── SCRAPE ────────────────────────────────────────────────────────
app.post("/api/scrape-brand", async (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) return res.status(400).json({ error: "searchTerm required" });

  let browser;
  try {
    const puppeteer = require("puppeteer-core");
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable";
    console.log(`\n[Scrape] "${searchTerm}" starting...`);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--window-size=1280,900"],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });

    const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=${encodeURIComponent(searchTerm)}&search_type=keyword_unordered&media_type=all`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(5000);

    // Dismiss any popups/cookie banners
    try {
      await page.click('[data-testid="cookie-policy-manage-dialog-accept-button"]');
      await sleep(1000);
    } catch {}
    try {
      const closeBtn = await page.$('div[aria-label="Close"]');
      if (closeBtn) { await closeBtn.click(); await sleep(1000); }
    } catch {}

    // Scroll to load ads
    console.log("[Scrape] Scrolling...");
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await sleep(1500);
    }

    // Extract ads
    const ads = await page.evaluate((search) => {
      const results = [];

      // Facebook Ad Library uses div-based cards — find by ad content patterns
      // Look for containers that have ad-specific content
      const allDivs = Array.from(document.querySelectorAll("div"));

      // Find divs that contain ad library specific structure
      // Ads typically have: page name, "Sponsored" or dates, ad copy
      const adContainers = allDivs.filter(div => {
        const text = div.innerText || "";
        const html = div.innerHTML || "";
        // Ad cards contain these patterns
        return (
          text.includes("Started running") ||
          (text.includes("Active") && text.length > 100 && text.length < 5000 && html.includes("href")) ||
          text.includes("Library ID:")
        ) && div.children.length > 2;
      });

      // Deduplicate by taking only top-level containers
      const seen = new Set();
      const unique = adContainers.filter(el => {
        const text = el.innerText?.trim().slice(0, 100);
        if (seen.has(text)) return false;
        seen.add(text);
        // Make sure parent isn't already included
        return !adContainers.some(other => other !== el && other.contains(el) && other.innerText?.length < el.innerText?.length * 2);
      });

      unique.slice(0, 100).forEach((card, idx) => {
        try {
          const text = card.innerText || "";
          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

          // Extract page name (usually first meaningful line or linked text)
          const links = Array.from(card.querySelectorAll("a"));
          let pageName = "";
          for (const link of links) {
            const t = link.innerText?.trim();
            if (t && t.length > 2 && t.length < 80 && !t.includes("http") && !t.includes("Library")) {
              pageName = t;
              break;
            }
          }
          if (!pageName) pageName = lines[0] || "";

          // Extract copy — lines that look like ad copy (not dates/IDs)
          const copyLines = lines.filter(l =>
            l.length > 20 &&
            !l.match(/^\d/) &&
            !l.includes("Started running") &&
            !l.includes("Library ID") &&
            !l.includes("Active") &&
            !l.includes("Inactive") &&
            !l.includes("See ad details") &&
            !l.includes("About this ad") &&
            pageName && l !== pageName
          );
          const copy = copyLines.slice(0, 6).join(" ").trim();

          // Date
          const dateMatch = text.match(/Started running on ([A-Za-z]+ \d+, \d+)/);
          const startDate = dateMatch ? dateMatch[1] : null;
          const isActive = text.toLowerCase().includes("active") && !text.toLowerCase().includes("inactive");

          // Images/videos
          const images = Array.from(card.querySelectorAll("img"))
            .map(img => img.src)
            .filter(src => src && src.startsWith("http") && !src.includes("static") && !src.includes("emoji"));

          const videos = Array.from(card.querySelectorAll("video"))
            .map(v => v.src).filter(Boolean);

          const snapshotLinks = Array.from(card.querySelectorAll('a[href*="snapshot"]'));
          const snapshotUrl = snapshotLinks[0]?.href || null;

          let type = "IMAGE";
          if (videos.length) type = "VIDEO";
          else if (images.length > 1) type = "CAROUSEL";

          if (copy && copy.length > 30 && !copy.includes("Search by keyword") && !copy.includes("These results incl") && !copy.includes("Subscribe to email") && pageName !== "Branded Content" && pageName !== "Meta Ad Library") {
            results.push({
              id: `ad_${idx}_${Date.now()}`,
              pageName: pageName.slice(0, 100),
              copy: copy.slice(0, 600),
              type,
              imageUrl: images[0] || null,
              videoUrl: videos[0] || null,
              startDate,
              isActive,
              snapshotUrl,
            });
          }
        } catch {}
      });

      return results;
    }, searchTerm);

    await browser.close();
    console.log(`[Scrape] ✓ ${ads.length} ads for "${searchTerm}"`);
    res.json({ success: true, ads, count: ads.length, searchTerm });

  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("[Scrape] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── REWRITE ───────────────────────────────────────────────────────
app.post("/api/rewrite", async (req, res) => {
  const { originalCopy, product, angle } = req.body;
  const config = loadConfig();

  const PRODUCTS = {
    "exxtra-oregano": "EXXTRA Oil of Oregano with Black Seed Oil (500mg, 85% carvacrol, wild Mediterranean harvest)",
    "exxtra-relief": "EXXTRA Miracle Relief Cream (16-ingredient topical for neuropathy/nerve pain, 45+ demographic)",
  };
  const ANGLES = {
    "antibiotic": "Antibiotic Cycle Breaker — biofilm penetration, gut microbiome restoration after antibiotic use",
    "parasite": "Parasite Cleanse — 21-day protocol, carvacrol as natural antiparasitic",
    "gut": "Gut Health / SIBO — dysbiosis, bloating, gut lining repair",
    "immune": "Immune Defense — natural antimicrobial, respiratory health",
    "candida": "Mold / Candida / Brain Fog — antifungal, cognitive clarity",
    "skin": "Skin From Inside — acne, eczema, gut-skin axis",
    "allergy": "Allergy Season — anti-inflammatory, histamine",
    "pain": "Nerve Pain / Neuropathy — topical relief",
    "wound": "Wounded Warrior — veteran demographic, chronic pain",
  };

  const prompt = `You are an expert direct-response copywriter for supplement brands.

Product: ${PRODUCTS[product] || product}
Angle: ${ANGLES[angle] || angle}

Original competitor ad:
"${originalCopy}"

Rewrite this for our product using the angle. Keep same emotional hooks and structure. Direct response, punchy, conversion-focused. Same length. Don't mention the competitor. Output the rewritten script only.`;

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

// ── ANALYZE ───────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { copy } = req.body;
  const config = loadConfig();
  const prompt = `Analyze this ad copy as a DR marketing expert. Be brief.

Ad: "${copy}"

1. HOOK TYPE
2. PERSUASION FRAMEWORK  
3. EMOTIONAL TRIGGERS
4. TARGET AVATAR
5. SWIPE RATING (1-10)
6. TOP 3 TAKEAWAYS`;

  try {
    if (config.claudeApiKey) {
      const fetch = require("node-fetch");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.claudeApiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await r.json();
      if (d.content?.[0]?.text) return res.json({ success: true, analysis: d.content[0].text });
    }
    if (config.geminiApiKey) {
      const text = await callGemini(config.geminiApiKey, [{ text: prompt }], 800);
      return res.json({ success: true, analysis: text });
    }
    res.status(400).json({ error: "No API keys configured." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(3000, () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║       🔍 AdSwipe Intel is running            ║");
  console.log("║   Open: http://localhost:3000                ║");
  console.log("║   Batch: http://localhost:3000/batch.html   ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
