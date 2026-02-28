import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;

// Protect all public endpoints except health check
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  if (!ROUTER_API_KEY) {
    return res.status(500).json({ error: "Missing ROUTER_API_KEY on server" });
  }

  const clientKey = req.header("X-API-KEY");
  if (!clientKey || clientKey !== ROUTER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const message = req.body?.message;
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }]
      })
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: data });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    res.json({ text, raw: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
