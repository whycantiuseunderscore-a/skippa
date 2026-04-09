/*
WHAT???? YOU CLOSED IT???????????
THAT'S IT.
I'M SUBMITTING ANOTHER PULL REQUEST!!!!!!!!!!!!!!!!!!!!!!
DON'T CLOSE IT!!!!!!!!!!!!!!!!!!
*/
"use strict";

require('dotenv').config();

// ─── Required env vars check ─────────────────────────────────────────────────
const REQUIRED_ENV = ["MONGO_URI", "SESSION_SECRET"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const express        = require("express");
const mongoose       = require("mongoose");
const session        = require("express-session");
const MongoStore     = require("connect-mongo").default;
const rateLimit      = require("express-rate-limit");
const mongoSanitize  = require("express-mongo-sanitize");
const crypto         = require("crypto");
const https          = require("https");
const path           = require("path");

const app      = express();
const PORT     = parseInt(process.env.PORT || "3000", 10);
const MONGO_URI = process.env.MONGO_URI;
const IS_PROD  = process.env.NODE_ENV === "production";

app.set('trust proxy', 1);

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
}).catch(err => {
  console.error("[FATAL] MongoDB connection failed:", err.message);
  process.exit(1);
});

mongoose.connection.on("error", err => console.error("[MongoDB]", err.message));

// ─── Schema ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:       { type: String, required: true, unique: true },
  profilePicture: { type: String, default: null },
  streak:         { type: Number, default: 0, min: 0 },
  lastCheckin:    { type: Date,   default: null },
  longestStreak:  { type: Number, default: 0, min: 0 },
  createdAt:      { type: Date,   default: Date.now, immutable: true },
});

userSchema.index({ username: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

const User = mongoose.model("User", userSchema);

function fetchScratchPfp(username) {
  return new Promise(resolve => {
    https.get(`https://api.scratch.mit.edu/users/${username}`, { headers: { "User-Agent": "Skippa-StreakApp/1.0" } }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body).profile.images['90x90']); }
        catch { resolve("https://cdn2.scratch.mit.edu/get_image/user/default_90.png"); }
      });
    }).on("error", () => resolve("https://cdn2.scratch.mit.edu/get_image/user/default_90.png"));
  });
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SCRATCH_COMMENTS_URL = "https://scratch.mit.edu/site-api/comments/user/coffeeandroses/";
const SCRATCH_USERNAME_RE  = /^[a-zA-Z0-9_\-]{3,20}$/;   // Scratch's own rules
const CODE_TTL_MS          = 10 * 60 * 1000;              // 10 minutes

const { BADGES } = require ('./badges.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function dayKey(date) { return date.toISOString().slice(0, 10); }
function todayUTC()     { return dayKey(new Date()); }
function yesterdayUTC() { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return dayKey(d); }

function newCsrfToken() { return crypto.randomBytes(32).toString("hex"); }

function verifyCsrf(token, expected) {
  if (!token || !expected || token.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex")); }
  catch { return false; }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Generate a random 6-digit code in SKIPPA-XXXXXX format
function generateVerifyCode() {
  const digits = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  return `SKIPPA-${digits}`;
}

// Fetch the Scratch comments page and return the most recent top-level comment
// as { author: string, content: string } or null on failure.
function fetchTopScratchComment() {
  return new Promise((resolve) => {
    const req = https.get(
      SCRATCH_COMMENTS_URL,
      {
        headers: {
          "User-Agent": "Skippa-StreakApp/1.0",
          "Accept":     "text/html",
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => {
          try {
            // Find the FIRST <li class="top-level-reply"> block
            const liMatch = body.match(/<li class="top-level-reply">([\s\S]*?)<\/li>/);
            if (!liMatch) return resolve(null);
            const li = liMatch[1];

            // Extract author from data-comment-user="..."
            const authorMatch = li.match(/data-comment-user="([^"]+)"/);
            if (!authorMatch) return resolve(null);
            const author = authorMatch[1].trim();

            // Extract content from <div class="content">..content..</div>
            // The content may contain nested anchor tags for @mentions — strip those
            const contentMatch = li.match(/<div class="content">([\s\S]*?)<\/div>/);
            if (!contentMatch) return resolve(null);
            // Strip HTML tags and decode basic entities, then trim
            let content = contentMatch[1]
              .replace(/<[^>]+>/g, " ")
              .replace(/&amp;/g,  "&")
              .replace(/&lt;/g,   "<")
              .replace(/&gt;/g,   ">")
              .replace(/&quot;/g, '"')
              .replace(/&#x27;/g, "'")
              .replace(/&#39;/g,  "'")
              .replace(/\s+/g,    " ")
              .trim();

            resolve({ author, content });
          } catch { resolve(null); }
        });
      }
    );
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false, limit: "4kb" }));
app.use(express.json({ limit: "4kb" }));
app.use(mongoSanitize({ replaceWith: "_" }));

app.use("/badges", express.static("badges", {
  index: false,
  dotfiles: "deny",
  maxAge: IS_PROD ? "7d" : 0,
}));

// Serve logo
app.get("/logo.png", (_req, res) => res.sendFile(path.resolve("logo.png")));

// ─── Session ─────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    ttl: 30 * 24 * 60 * 60,
    autoRemove: "native",
    touchAfter: 24 * 3600,
  }),
  name: "sid",
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ─── Rate limiters ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) => res.status(429).redirect("/login?err=rate"),
});

const checkinLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.redirect("/dashboard"),
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
});

app.use(generalLimiter);

// ─── Auth / CSRF middleware ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect("/login");
  next();
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = newCsrfToken();
  return req.session.csrf;
}

function requireCsrf(req, res, next) {
  const token    = req.body && req.body._csrf;
  const expected = req.session && req.session.csrf;
  if (!verifyCsrf(token, expected)) {
    return res.status(403).send(layout("Forbidden", `
      <div class="page"><div class="auth-box">
        <h1>Forbidden</h1>
        <p class="sub">Invalid or missing CSRF token. Please <a href="/">go back</a> and try again.</p>
      </div></div>`));
  }
  req.session.csrf = newCsrfToken();
  next();
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Light theme (default) ── */
  :root {
    --bg:         #ffffff;
    --surface:    #f6f5fb;
    --surface2:   #eceaf7;
    --border:     #e0dcf2;
    --text:       #1a1828;
    --muted:      #706e8a;
    --accent:     hsl(260,60%,60%);
    --accent-dim: hsla(260,60%,60%,0.12);
    --accent-dk:  hsl(260,60%,44%);
    --ok:         hsl(145,50%,38%);
    --ok-bg:      hsla(145,55%,50%,0.1);
    --ok-border:  hsla(145,55%,50%,0.22);
    --err:        hsl(0,60%,50%);
    --err-bg:     hsla(0,70%,60%,0.08);
    --err-border: hsla(0,70%,60%,0.22);
    --radius:     14px;
    --font:       "Helvetica Neue","Helvetica",Arial,sans-serif;
  }

  /* ── Dark theme via system preference ── */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:         #0f0e1a;
      --surface:    #1a1829;
      --surface2:   #201e33;
      --border:     #2e2b46;
      --text:       #f0eeff;
      --muted:      #9693b0;
      --accent-dim: hsla(260,60%,60%,0.18);
      --ok:         hsl(145,55%,62%);
      --ok-bg:      hsla(145,55%,50%,0.12);
      --ok-border:  hsla(145,55%,50%,0.25);
      --err:        hsl(0,70%,68%);
      --err-bg:     hsla(0,70%,60%,0.1);
      --err-border: hsla(0,70%,60%,0.25);
    }

    a {
    color: var(--text) !important;
    }
  }
  
  @media (max-width: 600px) {
    .hide-on-mobile {
      display: none;
    }
  }

  /* ── Force light ── */
  :root.light {
    --bg: #ffffff; --surface: #f6f5fb; --surface2: #eceaf7; --border: #e0dcf2;
    --text: #1a1828; --muted: #706e8a; --accent-dim: hsla(260,60%,60%,0.12);
    --ok: hsl(145,50%,38%); --ok-bg: hsla(145,55%,50%,0.1); --ok-border: hsla(145,55%,50%,0.22);
    --err: hsl(0,60%,50%); --err-bg: hsla(0,70%,60%,0.08); --err-border: hsla(0,70%,60%,0.22);
  }

  /* ── Force dark ── */
  :root.dark {
    --bg: #0f0e1a; --surface: #1a1829; --surface2: #201e33; --border: #2e2b46;
    --text: #f0eeff; --muted: #9693b0; --accent-dim: hsla(260,60%,60%,0.18);
    --ok: hsl(145,55%,62%); --ok-bg: hsla(145,55%,50%,0.12); --ok-border: hsla(145,55%,50%,0.25);
    --err: hsl(0,70%,68%); --err-bg: hsla(0,70%,60%,0.1); --err-border: hsla(0,70%,60%,0.25);
  }

  html, body {
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    transition: background 0.2s, color 0.2s;
  }

  /* ── Nav ── */
  nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 28px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    position: sticky;
    top: 0;
    z-index: 100;
    transition: background 0.2s, border-color 0.2s;
  }

  .nav-logo {
    display: flex;
    align-items: center;
    gap: 9px;
    text-decoration: none;
    color: var(--text);
  }
  .nav-logo-text {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.3rem;
      font-weight: 700;
      letter-spacing: -0.04em;
      color: var(--text);
    }
  .nav-links {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  nav a.nav-link {
    color: var(--muted);
    text-decoration: none;
    font-weight: 500;
    font-size: 0.9rem;
    padding: 7px 14px;
    border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }
  nav a.nav-link:hover { color: var(--text); background: var(--surface2); }

  nav a.btn-nav {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    padding: 7px 18px;
    border-radius: 8px;
    text-decoration: none;
    font-size: 0.9rem;
    transition: opacity 0.15s;
  }
  nav a.btn-nav:hover { opacity: 0.85; }

  .theme-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    width: 34px;
    height: 34px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.95rem;
    line-height: 1;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .theme-btn:hover { background: var(--surface2); color: var(--text); border-color: var(--accent); }

  /* ── Main layout ── */
  .page { max-width: 680px; margin: 0 auto; padding: 48px 24px 80px; }

  /* ── Auth box ── */
  .auth-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 36px;
    margin-top: 24px;
    transition: background 0.2s, border-color 0.2s;
  }
  .auth-box h1 { font-size: 1.45rem; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.02em; }
  .auth-box p.sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 26px; }

  /* ── Forms ── */
  .form-group { display: flex; flex-direction: column; gap: 5px; margin-bottom: 15px; }
  .form-group label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .form-group input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 11px 14px;
    color: var(--text);
    font-family: var(--font);
    font-size: 1rem;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .form-group input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .hint { font-size: 0.78rem; color: var(--muted); margin-top: 3px; }

  /* ── Buttons ── */
  .btn {
    display: inline-block;
    padding: 12px 24px;
    border-radius: 9px;
    border: none;
    font-family: var(--font);
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.12s;
    text-decoration: none;
    text-align: center;
  }
  .btn:hover { opacity: 0.86; transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; }

  .auth-switch { text-align: center; margin-top: 18px; color: var(--muted); font-size: 0.9rem; }
  .auth-switch a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .auth-switch a:hover { text-decoration: underline; }

  .alert {
    background: var(--err-bg);
    border: 1px solid var(--err-border);
    color: var(--err);
    border-radius: 9px;
    padding: 11px 14px;
    font-size: 0.9rem;
    margin-bottom: 18px;
  }

  /* ── Dashboard ── */
  .dashboard-header { margin-bottom: 28px; }
  .dashboard-header h1 { font-size: 1.25rem; font-weight: 500; color: var(--muted); }
  .dashboard-header h1 strong { color: var(--text); font-weight: 700; }

  .streak-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
    transition: background 0.2s, border-color 0.2s;
  }
  .streak-number { display: flex; align-items: baseline; gap: 8px; }
  .streak-number .num {
    font-size: 4rem;
    font-weight: 800;
    line-height: 1;
    color: var(--accent);
    letter-spacing: -0.04em;
  }
  .streak-number .label { font-size: 1rem; color: var(--muted); font-weight: 500; }
  .streak-meta { text-align: right; }
  .streak-meta .best { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .streak-meta .best strong { color: var(--text); font-weight: 700; }
  .streak-meta .status {
    margin-top: 8px;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 20px;
    display: inline-block;
  }
  .status-done {
    background: var(--ok-bg);
    color: var(--ok);
    border: 1px solid var(--ok-border);
  }
  .status-pending {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid hsla(260,60%,60%,0.25);
  }

  .checkin-wrap { margin-bottom: 28px; }
  .btn-checkin {
    width: 100%;
    padding: 18px;
    font-size: 1.05rem;
    border-radius: var(--radius);
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    border: none;
    cursor: pointer;
    font-family: var(--font);
    transition: opacity 0.15s, transform 0.12s;
  }
  .btn-checkin:hover:not(:disabled) { opacity: 0.86; transform: translateY(-2px); }
  .btn-checkin:active:not(:disabled) { transform: translateY(0); }
  .btn-checkin:disabled {
    background: var(--surface2);
    color: var(--muted);
    cursor: not-allowed;
    border: 1px solid var(--border);
  }

  .section-title {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--muted);
    margin-bottom: 11px;
  }
  .badges-list { display: flex; flex-direction: column; gap: 8px; }
  .badge-row {
    display: flex;
    align-items: center;
    gap: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 18px;
    transition: border-color 0.15s, background 0.15s;
  }
  .badge-row.unlocked { border-color: hsla(260,60%,60%,0.3); }
  .badge-row.unlocked:hover { border-color: hsla(260,60%,60%,0.55); background: var(--surface2); }
  .badge-icon { width: 52px; height: 52px; border-radius: 50%; flex-shrink: 0; object-fit: cover; transition: filter 0.2s; }
  .badge-row:not(.unlocked) .badge-icon { filter: grayscale(1) opacity(0.4); }
  .badge-row.unlocked .badge-icon { box-shadow: 0 0 0 2px hsla(260,60%,60%,0.45); }
  .badge-info { flex: 1; min-width: 0; }
  .badge-name { font-weight: 700; font-size: 0.95rem; color: var(--text); margin-bottom: 2px; display: flex; align-items: center; gap: 8px; }
  .badge-day-tag {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid hsla(260,60%,60%,0.2);
    font-weight: 600;
  }
  .badge-row:not(.unlocked) .badge-name { color: var(--muted); }
  .badge-row:not(.unlocked) .badge-day-tag { background: var(--surface2); color: var(--muted); border-color: var(--border); }
  .badge-desc { font-size: 0.85rem; color: var(--muted); line-height: 1.4; }

  .logout-form { display: inline; }
  .logout-form button {
    background: none;
    border: none;
    color: var(--muted);
    font-family: var(--font);
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    padding: 7px 14px;
    border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }
  .logout-form button:hover { color: var(--text); background: var(--surface2); }

  /* ── Hero ── */
  .hero { text-align: center; padding: 72px 0 52px; }
  .hero-eyebrow {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 20px;
  }
  .hero h1 {
    font-size: clamp(2.1rem, 6vw, 3.4rem);
    font-weight: 800;
    line-height: 1.14;
    margin-bottom: 18px;
    letter-spacing: -0.03em;
    color: var(--text);
  }
  .hero h1 em { font-style: normal; color: var(--accent); }
  .hero p {
    font-size: 1.05rem;
    color: var(--muted);
    max-width: 400px;
    margin: 0 auto 36px;
    line-height: 1.7;
  }
  .hero-cta { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .btn-hero-primary {
    background: var(--accent);
    color: #fff;
    padding: 13px 28px;
    font-size: 0.95rem;
    font-weight: 700;
    border-radius: 10px;
    text-decoration: none;
    font-family: var(--font);
    transition: opacity 0.15s, transform 0.12s;
  }
  .btn-hero-primary:hover { opacity: 0.86; transform: translateY(-1px); }
  .btn-hero-secondary {
    background: transparent;
    color: var(--muted);
    padding: 13px 24px;
    font-size: 0.95rem;
    font-weight: 600;
    border-radius: 10px;
    text-decoration: none;
    border: 1px solid var(--border);
    font-family: var(--font);
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-hero-secondary:hover { border-color: var(--muted); color: var(--text); }

  /* ── Features grid ── */
  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-top: 52px;
  }
  @media (max-width: 560px) { .features { grid-template-columns: 1fr; } }

  .feature-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px 20px;
    transition: border-color 0.15s, background 0.15s;
  }
  .feature-card:hover { border-color: hsla(260,60%,60%,0.35); background: var(--surface2); }
  .feature-icon { font-size: 1.5rem; margin-bottom: 10px; }
  .feature-title { font-weight: 700; font-size: 0.92rem; margin-bottom: 6px; color: var(--text); }
  .feature-desc { font-size: 0.83rem; color: var(--muted); line-height: 1.6; }

  /* ── Divider ── */
  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 52px 0 0;
  }

  /* ── Footer ── */
  footer {
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 24px 48px;
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.65;
    text-align: center;
  }
`;

// ─── Theme toggle script (inline, safe) ──────────────────────────────────────
const THEME_SCRIPT = `
  (function(){
    var t = localStorage.getItem('theme');
    if (t === 'dark')  document.documentElement.classList.add('dark');
    if (t === 'light') document.documentElement.classList.add('light');
  })();

  function _skippaToggle() {
    var html = document.documentElement;
    var isDark = html.classList.contains('dark') ||
      (!html.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
      html.classList.remove('dark'); html.classList.add('light');
      localStorage.setItem('theme', 'light');
    } else {
      html.classList.remove('light'); html.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    }
    _skippaUpdateBtn();
  }

  function _skippaUpdateBtn() {
    var html = document.documentElement;
    var isDark = html.classList.contains('dark') ||
      (!html.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = isDark ? '☀' : '☾';
  }

  document.addEventListener('DOMContentLoaded', _skippaUpdateBtn);
`;

// ─── Layout ───────────────────────────────────────────────────────────────────
function layout(title, body, { username = null, csrf = "", pfp = null } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <link rel="icon" href="https://scratch.mit.edu/favicon.ico" />
  <title>${esc(title)} — Skippa</title>
  <style>${CSS}</style>
  <script>${THEME_SCRIPT}</script>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/">
      <span class="nav-logo-text">streak.<span style="color: #f7a028;">skippa.xyz</span></span>
    </a>
    <div class="nav-links">
      ${username
        ? `<div style="display:flex;align-items:center;gap:8px;">
             ${pfp ? `<img src="${esc(pfp)}" alt="pfp" style="width:24px;height:24px;border-radius:50%;">` : ""}
             <span style="color:var(--muted);font-size:0.85rem;font-weight:500;" class="hide-on-mobile">@${esc(username)}</span>
           </div>
           <a class="nav-link hide-on-mobile" href="https://scratch.mit.edu/discuss/topic/876551/">Discussion Topic</a>
           <a class="nav-link hide-on-mobile" href="/leaderboard">Leaderboard</a>
           <form class="logout-form" method="POST" action="/logout">
             <input type="hidden" name="_csrf" value="${esc(csrf)}" />
             <button type="submit">Log out</button>
           </form>`
        : `<a class="btn-nav" href="/login">Log in</a>
           <a class="nav-link hide-on-mobile" href="/leaderboard">Leaderboard</a>
           <a class="nav-link hide-on-mobile" href="https://scratch.mit.edu/discuss/topic/876551/" target="_blank">Discussion Topic</a>`}
      <button class="theme-btn" id="theme-toggle" onclick="_skippaToggle()" aria-label="Toggle theme">☾</button>
    </div>
  </nav>
  ${body}
  <footer>
    Skippa.xyz is not associated or endorsed by Scratch Foundation or any of its associates.<br/>
    It is a website created by a Scratcher, for Scratchers.
  </footer>
</body>
</html>`;
}

// ─── Form helpers ─────────────────────────────────────────────────────────────

// Step 1: enter Scratch username
function loginStep1Form(csrf, { error = "" } = {}) {
  return layout("Log in", `
    <div class="page"><div class="auth-box">
      <h1>Log in with Scratch</h1>
      <p class="sub">Enter your Scratch username to get started.</p>
      ${error ? `<div class="alert">${esc(error)}</div>` : ""}
      <form method="POST" action="/login/scratch" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}" />
        <div class="form-group">
          <label for="u">Scratch username</label>
          <input id="u" name="username" type="text" autocomplete="off"
            required autofocus maxlength="20" placeholder="griffpatch" />
        </div>
        <button class="btn btn-primary" type="submit">Continue →</button>
      </form>
    </div></div>`);
}

// Step 2: show the code and ask to verify
function loginStep2Form(csrf, { error = "", username = "", code = "" } = {}) {
  return layout("Verify your Scratch account", `
    <div class="page"><div class="auth-box">
      <h1>Verify your Scratch account</h1>
      <p class="sub">Post the code below as a comment on
        <a href="https://scratch.mit.edu/users/coffeeandroses/" target="_blank" rel="noopener">
          coffeeandroses's profile</a>, then click Verify.
      </p>
      ${error ? `<div class="alert">${esc(error)}</div>` : ""}
      <div style="
        font-size:1.35rem;
        font-weight:800;
        letter-spacing:0.08em;
        text-align:center;
        background:var(--surface2);
        border:2px dashed var(--accent);
        border-radius:12px;
        padding:20px 16px;
        margin-bottom:22px;
        color:var(--accent);
        user-select:all;
      ">${esc(code)}</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:20px;text-align:center;">
        Not logged in as <strong>@${esc(username)}</strong> on Scratch?
        <a href="/login">Use a different username</a>
      </p>
      <form method="POST" action="/login/scratch/verify" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}" />
        <button class="btn btn-primary" type="submit">✓ I've posted it — Verify me</button>
      </form>
      <p class="hint" style="text-align:center;margin-top:12px;">Code expires in 10 minutes.</p>
    </div></div>`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing
app.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.send(layout("Daily Streak", `
    <div class="page">
      <div class="hero">
        <p class="hero-eyebrow">✦ One click a day ✦</p>
        <h1>Build a streak.<br/><em>Collect characters.</em></h1>
        <p>Show up every day, click the button, and unlock Scratch characters as your streak grows.</p>
        <div class="hero-cta">
          <a class="btn-hero-primary" href="/login">Log in with Scratch</a>
        </div>
      </div>
      <hr class="divider" />
    </div>`));
});

// ── Scratch Login: Step 1 GET — show username form ───────────────────────────
app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  // Clear any stale pending challenge
  delete req.session.scratchChallenge;
  res.send(loginStep1Form(csrfToken(req)));
});

// ── /register redirects to /login (no separate registration anymore) ─────────
app.get("/register", (_req, res) => res.redirect("/login"));
app.post("/register", (_req, res) => res.redirect("/login"));

// ── Scratch Login: Step 1 POST — validate username, issue code ───────────────
app.post("/login/scratch", authLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");

  const rawUsername = String(req.body.username || "").trim();
  const csrf        = csrfToken(req);

  if (!SCRATCH_USERNAME_RE.test(rawUsername)) {
    return res.status(422).send(loginStep1Form(csrf, {
      error: "That doesn't look like a valid Scratch username (3–20 chars, letters/numbers/-/_).",
    }));
  }

  // Issue a fresh challenge and store it server-side in the session only
  const code      = generateVerifyCode();
  const expiresAt = Date.now() + CODE_TTL_MS;

  req.session.scratchChallenge = { username: rawUsername, code, expiresAt };
  await new Promise((ok, fail) =>
    req.session.save(err => err ? fail(err) : ok())
  );

  res.send(loginStep2Form(csrfToken(req), { username: rawUsername, code }));
}));

// ── Scratch Login: Step 2 GET — redirect to step 1 if no pending challenge ───
app.get("/login/scratch/verify", (req, res) => {
  if (req.session.scratchChallenge) {
    const { username, code } = req.session.scratchChallenge;
    return res.send(loginStep2Form(csrfToken(req), { username, code }));
  }
  res.redirect("/login");
});

// ── Scratch Login: Step 2 POST — verify comment, log in / create account ─────
app.post("/login/scratch/verify", authLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");

  const challenge = req.session.scratchChallenge;

  // Guard: must have a valid pending challenge in this session
  if (!challenge || !challenge.username || !challenge.code || !challenge.expiresAt) {
    return res.status(400).redirect("/login");
  }

  const { username: expectedUsername, code: expectedCode } = challenge;

  if (Date.now() > challenge.expiresAt) {
    delete req.session.scratchChallenge;
    req.session.save(() => {});
    return res.status(410).send(loginStep1Form(csrfToken(req), {
      error: "Your verification code expired. Please start again.",
    }));
  }

  // Fetch the most recent top-level comment from coffeeandroses's Scratch profile
  const comment = await fetchTopScratchComment();

  if (!comment) {
    return res.status(502).send(loginStep2Form(csrfToken(req), {
      error: "Couldn't reach Scratch right now. Please try again in a moment.",
      username: expectedUsername,
      code: expectedCode,
    }));
  }

  // ── Security check 1: the comment AUTHOR must match the claimed username
  //    (case-insensitive so e.g. "CoolKid" and "coolkid" are the same person)
  if (comment.author.toLowerCase() !== expectedUsername.toLowerCase()) {
    return res.status(401).send(loginStep2Form(csrfToken(req), {
      error: `The most recent comment was by @${esc(comment.author)}, not @${esc(expectedUsername)}. Make sure your comment is the newest one on that profile.`,
      username: expectedUsername,
      code: expectedCode,
    }));
  }

  // ── Security check 2: the comment CONTENT must contain the exact code
  //    (case-sensitive — SKIPPA-XXXXXX is always uppercase, collision is negligible)
  if (!comment.content.includes(expectedCode)) {
    return res.status(401).send(loginStep2Form(csrfToken(req), {
      error: "The code in your comment doesn't match. Make sure you copied it exactly.",
      username: expectedUsername,
      code: expectedCode,
    }));
  }

  // ── Passed — invalidate the challenge immediately (single-use) ───────────
  delete req.session.scratchChallenge;

  // Use the exact casing Scratch returned as the canonical username
  const canonicalUsername = comment.author;
  const pfp = await fetchScratchPfp(canonicalUsername);

  let user = await User.findOne({ username: canonicalUsername }).collation({ locale: "en", strength: 2 });

  if (!user) {
    user = await User.create({ username: canonicalUsername, profilePicture: pfp });
  } else if (!user.profilePicture || user.profilePicture !== pfp) {
    user.profilePicture = pfp;
    await user.save();
  }

  req.session.regenerate(err => {
    if (err) { console.error("Session regenerate:", err); return res.redirect("/login"); }
    req.session.userId   = user._id.toString();
    req.session.username = user.username;
    req.session.pfp      = user.profilePicture;
    req.session.csrf     = newCsrfToken();
    req.session.save(() => res.redirect("/dashboard"));
  });
}));

// Logout
app.post("/logout", requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.redirect("/");
  });
});

// Dashboard
app.get("/dashboard", requireAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.session.userId).lean();
  if (!user) { req.session.destroy(); return res.redirect("/login"); }

  const todayStr      = todayUTC();
  const lastDay       = user.lastCheckin ? dayKey(user.lastCheckin) : null;
  const alreadyDone   = lastDay === todayStr;
  const streakAlive   = lastDay === todayStr || lastDay === yesterdayUTC();
  const displayStreak = streakAlive ? user.streak : 0;
  const csrf          = csrfToken(req);

  const badgesHTML = BADGES.map(b => {
    const unlocked = user.longestStreak >= b.days;
    return `
      <div class="badge-row ${unlocked ? "unlocked" : ""}">
        <img class="badge-icon" src="${(b.id != '[REDACTED]' && b.id != '[REDACTED]' && b.id != 'Zepto' && b.id != 'Milli') ? esc(b.img) : (unlocked ? esc(b.img) : 'badges/unknown.png')}" alt="${(b.id != '[REDACTED]' && b.id != '[REDACTED]' && b.id != '[REDACTED]' && b.id != '[REDACTED]') ? esc(b.name) : (unlocked ? esc(b.name) : '???')}" width="52" height="52" />
        <div class="badge-info">
          <div class="badge-name">
            ${(b.id != '[REDACTED]' && b.id != '[REDACTED]' && b.id != 'Zepto' && b.id != 'Milli') ? esc(b.name) : (unlocked ? esc(b.name) : '???')}
            <span class="badge-day-tag">Day ${esc(String(b.days))}</span>
          </div>
          <div class="badge-desc">${unlocked ? esc(b.desc) : "???"}</div>
        </div>
      </div>`;
  }).join("");

  const checkinSection = alreadyDone
    ? `<button class="btn-checkin" disabled>✓ Already checked in today</button>`
    : `<form method="POST" action="/checkin">
         <input type="hidden" name="_csrf" value="${esc(csrf)}" />
         <button class="btn-checkin" type="submit">☀ Check in for today</button>
       </form>`;

  res.send(layout("Dashboard", `
    <div class="page">
      <div class="dashboard-header" style="display:flex;align-items:center;gap:12px;margin-bottom:28px;">
        ${user.profilePicture ? `<img src="${esc(user.profilePicture)}" alt="pfp" style="width:48px;height:48px;border-radius:50%;">` : ""}
        <h1 style="margin:0;font-size:1.25rem;font-weight:500;color:var(--muted);">👋 ${['Hey', 'Hi', 'Hello', 'Howdy', 'Welcome back', '\'Sup', 'What\'s up', 'Hiii', 'Heya'][Math.floor(Math.random() * 9)]}, <strong style="color:var(--text);font-weight:700;">@${esc(user.username)}</strong>!</h1>
      </div>
      <div class="streak-card">
        <div class="streak-number">
          <span class="num">${esc(String(displayStreak))}</span>
          <span class="label">day streak</span>
        </div>
        <div class="streak-meta">
          <div class="best">Best: <strong>${esc(String(user.longestStreak))}</strong> days</div>
          <div class="status ${alreadyDone ? "status-done" : "status-pending"}">
            ${alreadyDone ? "✓ Done today" : "● Pending"}
          </div>
        </div>
      </div>
      <div class="checkin-wrap">
        ${checkinSection}
      </div>
      <p class="section-title">Your badges (${BADGES.filter(b=>user.longestStreak >= b.days).length}/${BADGES.length})</p>
      <div class="badges-list">
        ${badgesHTML}
      </div>
    </div>`, { username: user.username, csrf, pfp: user.profilePicture}));
}));

// Check-in POST
app.post("/checkin", requireAuth, checkinLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const todayStr = todayUTC();
  const prevDay  = yesterdayUTC();

  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(); return res.redirect("/login"); }

  const lastDay = user.lastCheckin ? dayKey(user.lastCheckin) : null;

  if (lastDay === todayStr) return res.redirect("/dashboard");

  const newStreak = (lastDay === prevDay) ? user.streak + 1 : 1;

  const updated = await User.findOneAndUpdate(
    {
      _id: user._id,
      $or: [
        { lastCheckin: null },
        { lastCheckin: { $lt: new Date(todayStr + "T00:00:00.000Z") } },
      ],
    },
    {
      $set: {
        streak:        newStreak,
        lastCheckin:   new Date(),
        longestStreak: Math.max(newStreak, user.longestStreak),
      },
    },
    { new: true }
  );

  if (!updated) return res.redirect("/dashboard");

  res.redirect("/dashboard");
}));

app.get("/leaderboard", async (req, res) => {
  try {
    const topUsers = await User.find({ longestStreak: { $gt: 0 } })
      .sort({ longestStreak: -1 })
      .limit(5)
      .lean();

    const htmlList = topUsers.map((u, i) => `
      <div style="display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--border);">
        <strong style="font-size:1.2rem;width:24px;">#${i + 1}</strong>
        ${u.profilePicture ? `<img src="${esc(u.profilePicture)}" style="width:36px;height:36px;border-radius:50%;">` : ""}
        <span style="font-weight:600;font-size:1.1rem;"><a href="https://scratch.mit.edu/users/${esc(u.username)}/" target="_blank" rel="noopener" style="text-decoration:none;">${esc(u.username)}</a></span>
        <span style="margin-left:auto;font-weight:700;color:var(--text);">🔥 ${u.longestStreak}</span>
      </div>
    `).join("") || "<p style='padding:16px;'>No streaks recorded yet.</p>";

    res.send(layout("Leaderboard", `
      <div class="page">
        <h1 style="margin-bottom:24px;">🏆 Top 5 Scratchers</h1>
        <div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;">
          ${htmlList}
        </div>
        <span style="font-size:0.8rem;color:var(--muted);margin-top:24px;display:block;text-align:center;">* All data is pulled from the scratch.mit.edu website; users cannot upload content on Skippa.</span>
      </div>
    `, { 
      username: req.session.username, 
      csrf: req.session.csrf, 
      pfp: req.session.pfp 
    }));
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).send("Server Error");
  }
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).send(layout("Not Found", `
    <div class="page"><div class="auth-box">
      <h1>404</h1>
      <p class="sub">That page doesn't exist. <a href="/">Go home.</a></p>
    </div></div>`));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("[Error]", err);
  res.status(500).send(layout("Error", `
    <div class="page"><div class="auth-box">
      <h1>Something went wrong</h1>
      <p class="sub">An internal error occurred. Please try again.</p>
    </div></div>`));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Skippa running on port ${PORT}`);
});

process.on("SIGTERM", () => mongoose.connection.close(() => process.exit(0)));
process.on("SIGINT",  () => mongoose.connection.close(() => process.exit(0)));
