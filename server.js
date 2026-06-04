const http = require("http");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const rateBuckets = new Map();
let messageWriteQueue = Promise.resolve();

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fsSync.existsSync(envPath)) {
    return;
  }

  const lines = fsSync.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function setBaseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'"
  );
}

function sendJson(res, statusCode, payload) {
  setBaseHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  setBaseHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getClientKey(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(key) {
  const now = Date.now();
  const current = rateBuckets.get(key) || [];
  const active = current.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);

  if (active.length >= RATE_LIMIT) {
    rateBuckets.set(key, active);
    return true;
  }

  active.push(now);
  rateBuckets.set(key, active);
  return false;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
}

function normalizeContact(payload) {
  const name = cleanText(payload.name, 80);
  const email = cleanText(payload.email, 120).toLowerCase();
  const service = cleanText(payload.service, 80);
  const budget = cleanText(payload.budget, 80);
  const timeline = cleanText(payload.timeline, 80);
  const message = cleanText(payload.message, 1200);
  const honeypot = cleanText(payload.companyWebsite, 160);

  if (honeypot) {
    return { error: "Unable to accept this request." };
  }

  if (name.length < 2) {
    return { error: "Please enter your name." };
  }

  if (!isEmail(email)) {
    return { error: "Please enter a valid email address." };
  }

  if (message.length < 12) {
    return { error: "Please add a little more detail about the project." };
  }

  return {
    value: {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name,
      email,
      service,
      budget,
      timeline,
      message,
      source: "website"
    }
  };
}

async function saveMessage(message) {
  messageWriteQueue = messageWriteQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const messages = await readJson(MESSAGES_FILE, []);
    messages.unshift(message);
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2), "utf8");
  });

  return messageWriteQueue;
}

async function notifyWebhook(message) {
  const webhookUrl = process.env.CONTACT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    });
  } catch (error) {
    console.warn("Contact webhook failed:", error.message);
  }
}

async function handleContact(req, res) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) {
    sendJson(res, 415, { ok: false, error: "Please send JSON." });
    return;
  }

  if (isRateLimited(getClientKey(req))) {
    sendJson(res, 429, {
      ok: false,
      error: "Too many messages were sent recently. Please try again later."
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "Invalid request body." });
    return;
  }

  const result = normalizeContact(payload);
  if (result.error) {
    sendJson(res, 400, { ok: false, error: result.error });
    return;
  }

  await saveMessage(result.value);
  notifyWebhook(result.value);

  sendJson(res, 201, {
    ok: true,
    id: result.value.id,
    message: "Thanks. Your message has been received."
  });
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return false;
  }
  return req.headers.authorization === `Bearer ${adminToken}`;
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "akshay-website",
      uptime: Math.round(process.uptime())
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/profile") {
    sendJson(res, 200, await readJson(path.join(DATA_DIR, "profile.json"), {}));
    return;
  }

  if (req.method === "GET" && pathname === "/api/projects") {
    sendJson(res, 200, await readJson(path.join(DATA_DIR, "projects.json"), []));
    return;
  }

  if (req.method === "POST" && pathname === "/api/contact") {
    await handleContact(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/messages") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "Admin token required." });
      return;
    }

    sendJson(res, 200, await readJson(MESSAGES_FILE, []));
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found." });
}

async function serveStatic(req, res, pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.join(PUBLIC_DIR, requestedPath);
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    const finalPath = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const ext = path.extname(finalPath).toLowerCase();
    const body = await fs.readFile(finalPath);

    setBaseHeaders(res);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=86400"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: "Server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Akshay website running at http://localhost:${PORT}`);
});
