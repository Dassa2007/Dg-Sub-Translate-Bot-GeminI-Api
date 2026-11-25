import axios from "axios";
import AdmZip from "adm-zip";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const MAX_FILES_PER_ZIP = 15;
const SUBTITLE_BATCH_SIZE = 15;

function tgApi(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function sendMessage(chatId, text) {
  await axios.post(tgApi("sendMessage"), {
    chat_id: chatId,
    text,
  });
}

async function sendDocumentBuffer(chatId, buffer, filename, caption = "") {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "application/zip" });
  formData.append("chat_id", String(chatId));
  formData.append("document", blob, filename);
  if (caption) formData.append("caption", caption);

  const res = await fetch(tgApi("sendDocument"), {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram sendDocument failed: ${errText}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSrtBlocks(srtText) {
  const normalized = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];

  const rawBlocks = normalized.split(/\n\s*\n/);
  const blocks = [];

  for (const raw of rawBlocks) {
    const lines = raw.split("\n").map((l) => l.trimEnd());
    if (lines.length >= 2) {
      const index = lines[0].trim();
      const timecode = lines[1].trim();
      const text = lines.slice(2).join("\n").trim();
      if (timecode.includes("-->")) {
        blocks.push({ index, timecode, text });
      }
    }
  }
  return blocks;
}

async function callGeminiSpokenSinhala(itemsToTranslate, retries = 3) {
  const prompt = `
Translate these subtitle lines from ANY language into natural, everyday SPOKEN SINHALA (කතා කරන සිංහල - friendly natural spoken dialogue, NOT stiff literary Sinhala).

Rules:
1. Keep exact array length and exact order. Return ONLY a valid JSON array of strings.
2. Keep tags like <i>, </i>, <b>, </b> or line breaks if present.
3. No markdown fences or extra text.

Lines (${itemsToTranslate.length}):
${JSON.stringify(itemsToTranslate)}
`.trim();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: "application/json",
          },
        },
        { timeout: 45000 }
      );

      const rawText =
        response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();

      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length === itemsToTranslate.length) {
        return parsed.map((x) => String(x));
      }

      throw new Error("JSON array length mismatch from Gemini");
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1200 * attempt);
    }
  }
}

async function translateSingleSrt(srtContent) {
  const blocks = parseSrtBlocks(srtContent);
  if (blocks.length === 0) return srtContent;

  for (let i = 0; i < blocks.length; i += SUBTITLE_BATCH_SIZE) {
    const batch = blocks.slice(i, i + SUBTITLE_BATCH_SIZE);
    const texts = batch.map((b) => b.text);
    const translated = await callGeminiSpokenSinhala(texts);

    for (let j = 0; j < batch.length; j++) {
      blocks[i + j].text = translated[j];
    }
  }

  return blocks
    .map((b, idx) => `${idx + 1}\n${b.timecode}\n${b.text}`)
    .join("\n\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("ZIP SRT Sinhala Translator Bot is active!");
  }

  try {
    const update = req.body;
    const message = update?.message;
    if (!message) return res.status(200).send("OK");

    const chatId = message.chat.id;
    const text = message.text || "";

    if (text === "/start") {
      await sendMessage(
        chatId,
        "👋 .srt files තියෙන .zip file එකක් එවන්න (එකපාර files 15ක් දක්වා). මම ඒවා කතා කරන සිංහලට හරවලා අලුත් ZIP file එකක් විදියට එවන්නම්."
      );
      return res.status(200).send("OK");
    }

    const doc = message.document;
    if (!doc) {
      await sendMessage(chatId, "කරුණාකර .srt files ඇතුළත් .zip file එකක් එවන්න.");
      return res.status(200).send("OK");
    }

    const fileName = doc.file_name || "subtitles.zip";
    if (!fileName.toLowerCase().endsWith(".zip")) {
      await sendMessage(chatId, "❌ .zip file එකක් පමණක් එවන්න.");
      return res.status(200).send("OK");
    }

    await sendMessage(chatId, `📦 "${fileName}" download කරලා extract කරනවා...`);

    const fileInfoRes = await axios.get(tgApi("getFile"), {
      params: { file_id: doc.file_id },
    });
    const filePath = fileInfoRes.data?.result?.file_path;
    if (!filePath) throw new Error("Telegram file_path ලබාගත නොහැකි විය.");

    const zipDownloadRes = await axios.get(
      `[https://api.telegram.org/file/bot$](https://api.telegram.org/file/bot$){BOT_TOKEN}/${filePath}`,
      { responseType: "arraybuffer" }
    );

    const inputZip = new AdmZip(Buffer.from(zipDownloadRes.data));
    const srtEntries = inputZip
      .getEntries()
      .filter(
        (entry) =>
          !entry.isDirectory &&
          !entry.entryName.includes("__MACOSX") &&
          !entry.entryName.split("/").pop().startsWith("._") &&
          entry.entryName.toLowerCase().endsWith(".srt")
      )
      .slice(0, MAX_FILES_PER_ZIP);

    if (srtEntries.length === 0) {
      await sendMessage(chatId, "⚠️ ZIP file එක ඇතුළේ .srt files හමු නොවුණි.");
      return res.status(200).send("OK");
    }

    await sendMessage(
      chatId,
      `✅ .srt files ${srtEntries.length}ක් හමුවුණා. කතා කරන සිංහලට translate කරනවා...`
    );

    const outputZip = new AdmZip();

    for (let idx = 0; idx < srtEntries.length; idx++) {
      const entry = srtEntries[idx];
      const baseName = entry.entryName.split("/").pop();
      await sendMessage(
        chatId,
        `🔄 (${idx + 1}/${srtEntries.length}) "${baseName}" translate කරනවා...`
      );

      const srtContent = entry.getData().toString("utf8");
      const translatedSrt = await translateSingleSrt(srtContent);
      outputZip.addFile(
        `Sinhala_${baseName}`,
        Buffer.from(translatedSrt, "utf8")
      );
    }

    const outZipBuffer = outputZip.toBuffer();
    const outZipName = `Sinhala_${fileName}`;

    await sendDocumentBuffer(
      chatId,
      outZipBuffer,
      outZipName,
      `🎉 සාර්ථකව translate කළා! Files ${srtEntries.length}ක් තියෙන ZIP එක මෙන්න.`
    );

    return res.status(200).send("OK");
  } catch (error) {
    console.error("ZIP Bot Error:", error);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) {
      await sendMessage(
        chatId,
        `⚠️ Error එකක් ආවා: ${error.message || "Unknown error"}`
      ).catch(() => {});
    }
    return res.status(200).send("OK");
  }
}
