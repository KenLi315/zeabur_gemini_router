import express from "express";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  
  // 🌟 核心修改：動態讀取前端發過來的所有 Headers 並直接原樣放行，一勞永逸！
  const clientHeaders = req.header("Access-Control-Request-Headers");
  if (clientHeaders) {
    res.setHeader("Access-Control-Allow-Headers", clientHeaders);
  } else {
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With, content-type, Authorization, X-API-KEY");
  }
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;

const AUDIO_MIME_BY_FORMAT = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm"
};

const mapGeminiFinishReason = (finishReason) => {
  switch (finishReason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content_filter";
    default:
      return "stop";
  }
};

const normalizeMessageContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
};

const sendOpenAIError = (res, status, message, type = "invalid_request_error", code = null) => {
  return res.status(status).json({
    error: {
      message,
      type,
      param: null,
      code
    }
  });
};

const parseDataUrl = (value) => {
  if (typeof value !== "string") return null;
  const matched = value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!matched) return null;
  return { mimeType: matched[1], data: matched[2] };
};

const resolveAudioMimeType = (format) => {
  if (!format) return "audio/wav";
  if (format.includes("/")) return format;
  return AUDIO_MIME_BY_FORMAT[format.toLowerCase()] || "audio/wav";
};

const fetchUrlAsBase64 = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch media URL: ${url}`);
  }
  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  const bytes = await response.arrayBuffer();
  return {
    mimeType,
    data: Buffer.from(bytes).toString("base64")
  };
};

const toGeminiPartFromImageItem = async (item) => {
  const imageUrl = typeof item?.image_url === "string"
    ? item.image_url
    : item?.image_url?.url;
  if (!imageUrl) return null;

  const inline = parseDataUrl(imageUrl);
  if (inline) {
    return { inlineData: inline };
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    const fetched = await fetchUrlAsBase64(imageUrl);
    return { inlineData: fetched };
  }
  throw new Error("image_url must be a data URL or http(s) URL.");
};

const toGeminiPartFromAudioItem = (item) => {
  const inputAudio = item?.input_audio || {};
  if (typeof inputAudio?.data !== "string" || !inputAudio.data) {
    return null;
  }
  return {
    inlineData: {
      mimeType: resolveAudioMimeType(inputAudio.format),
      data: inputAudio.data
    }
  };
};

const buildGeminiPartsFromContent = async (content) => {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      parts.push({ text: item.text });
      continue;
    }
    if (item?.type === "image_url") {
      const imagePart = await toGeminiPartFromImageItem(item);
      if (imagePart) parts.push(imagePart);
      continue;
    }
    if (item?.type === "input_audio") {
      const audioPart = toGeminiPartFromAudioItem(item);
      if (audioPart) parts.push(audioPart);
    }
  }
  return parts;
};

const toOpenAIContentPart = (geminiPart) => {
  if (typeof geminiPart?.text === "string") {
    return { type: "text", text: geminiPart.text };
  }

  const mimeType = geminiPart?.inlineData?.mimeType;
  const data = geminiPart?.inlineData?.data;
  if (!mimeType || !data) return null;

  if (mimeType.startsWith("image/")) {
    return {
      type: "image_base64",
      image_base64: {
        mime_type: mimeType,
        data
      }
    };
  }
  if (mimeType.startsWith("audio/")) {
    return {
      type: "audio_base64",
      audio_base64: {
        mime_type: mimeType,
        data
      }
    };
  }
  return {
    type: "file_base64",
    file_base64: {
      mime_type: mimeType,
      data
    }
  };
};

// Protect all public endpoints except health check.
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  if (!ROUTER_API_KEY) {
    return res.status(500).json({ error: "Missing ROUTER_API_KEY on server" });
  }

  const headerKey = req.header("X-API-KEY");
  const authHeader = req.header("Authorization");
  const bearerKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const clientKey = headerKey || bearerKey;

  if (!clientKey || clientKey !== ROUTER_API_KEY) {
    return sendOpenAIError(res, 401, "Unauthorized", "authentication_error", "invalid_api_key");
  }

  next();
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/v1/models", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return sendOpenAIError(
        res,
        500,
        "Server missing GEMINI_API_KEY",
        "server_error",
        "missing_gemini_api_key"
      );
    }

    const method = typeof req.query.method === "string" && req.query.method
      ? req.query.method
      : "generateContent";

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const r = await fetch(endpoint);
    const data = await r.json();

    if (!r.ok) {
      const message = data?.error?.message || "Failed to list Gemini models.";
      const statusCode = data?.error?.status || "upstream_error";
      return sendOpenAIError(res, r.status, message, "api_error", statusCode);
    }

    const models = Array.isArray(data?.models) ? data.models : [];
    const filtered = models.filter((model) =>
      Array.isArray(model?.supportedGenerationMethods) &&
      model.supportedGenerationMethods.includes(method)
    );

    res.json({
      object: "list",
      data: filtered.map((model) => ({
        id: model.name?.replace(/^models\//, "") || model.name,
        object: "model",
        created: 0,
        owned_by: "google",
        metadata: {
          full_name: model.name,
          display_name: model.displayName || null,
          description: model.description || null,
          input_token_limit: model.inputTokenLimit ?? null,
          output_token_limit: model.outputTokenLimit ?? null,
          supported_generation_methods: model.supportedGenerationMethods || []
        }
      }))
    });
  } catch (e) {
    sendOpenAIError(res, 500, e.message || "Internal server error", "server_error", "internal_error");
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return sendOpenAIError(
        res,
        500,
        "Server missing GEMINI_API_KEY",
        "server_error",
        "missing_gemini_api_key"
      );
    }

    // 🌟 終極萬用洗滌網：徹底摧毀 BMO REST API 函數夾帶的所有進階雜質參數！
    const { messages: clientMessages } = req.body || {};
    
    // 強制將模型名稱鎖死為健康的真實 Google 模型，拒絕接收前端傳過來的任何 OpenAI 變形名稱
    const model = GEMINI_MODEL; 
    
    let messages = [];

    // 多重防禦補全
    if (Array.isArray(clientMessages) && clientMessages.length > 0) {
      messages = clientMessages;
    } else if (typeof req.body?.prompt === "string" && req.body.prompt) {
      messages = [{ role: "user", content: req.body.prompt }];
    } else if (req.body?.content && typeof req.body.content === "string") {
      messages = [{ role: "user", content: req.body.content }];
    } else {
      messages = [{ role: "user", content: "Hello" }];
    }


    if (!Array.isArray(messages) || messages.length === 0) {
      return sendOpenAIError(
        res,
        400,
        "Invalid request: 'messages' must be a non-empty array.",
        "invalid_request_error",
        "invalid_messages"
      );
    }

    const systemText = messages
      .filter((m) => m?.role === "system")
      .map((m) => normalizeMessageContent(m?.content))
      .filter(Boolean)
      .join("\n");

    const conversation = [];
    for (const message of messages) {
      if (message?.role === "system") continue;
      const role = message?.role === "assistant" ? "model" : "user";
      const parts = await buildGeminiPartsFromContent(message?.content);
      if (parts.length > 0) {
        conversation.push({ role, parts });
      }
    }

    if (conversation.length === 0) {
      return sendOpenAIError(
        res,
        400,
        "Invalid request: no usable text/image/audio content found in messages.",
        "invalid_request_error",
        "empty_content"
      );
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiPayload = {
      contents: conversation
    };

    if (systemText) {
      geminiPayload.system_instruction = {
        parts: [{ text: systemText }]
      };
    }

    const generationConfig = {};
    if (typeof req.body?.temperature === "number") {
      generationConfig.temperature = req.body.temperature;
    }
    if (typeof req.body?.top_p === "number") {
      generationConfig.topP = req.body.top_p;
    }
    if (typeof req.body?.max_tokens === "number") {
      generationConfig.maxOutputTokens = req.body.max_tokens;
    }
    if (Object.keys(generationConfig).length > 0) {
      geminiPayload.generationConfig = generationConfig;
    }

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      const message =
        data?.error?.message || "Upstream Gemini API request failed.";
      const statusCode = data?.error?.status || "upstream_error";
      return sendOpenAIError(res, r.status, message, "api_error", statusCode);
    }

    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const contentParts = responseParts.map(toOpenAIContentPart).filter(Boolean);
    const textOnly = contentParts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const messageContent = contentParts.length === 1 && contentParts[0].type === "text"
      ? contentParts[0].text
      : contentParts;
    const finishReason = mapGeminiFinishReason(data?.candidates?.[0]?.finishReason);
    const usage = data?.usageMetadata || {};
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${Date.now()}`;

    res.json({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: messageContent
          },
          finish_reason: finishReason
        }
      ],
      usage: {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      },
      text: textOnly
    });
  } catch (e) {
    sendOpenAIError(res, 500, e.message || "Internal server error", "server_error", "internal_error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
