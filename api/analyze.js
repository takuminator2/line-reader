module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(400).json({ error: "APIキーが設定されていません" });
  }

  const { image, mediaType, context } = req.body;
  if (!image) {
    return res.status(400).json({ error: "画像がアップロードされていませんでした" });
  }

  try {
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: image },
              features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
              imageContext: { languageHints: ["ja", "en"] },
            },
          ],
        }),
      }
    );

    const visionData = await visionRes.json();

    if (visionData.error) {
      return res.status(400).json({
        error: `Google API エラー (${visionData.error.code}): ${visionData.error.message}\n\n対処法:\n・Cloud Vision API が「有効」になっているか確認\n・APIキーが正しくコピーされているか確認\n・APIキーの制限で Cloud Vision API が許可されているか確認`,
      });
    }

    const apiResult = visionData.responses?.[0];
    if (apiResult?.error) {
      return res.status(400).json({
        error: `Vision API エラー (${apiResult.error.code}): ${apiResult.error.message}`,
      });
    }

    const result = parseVisionResult(apiResult, context || "");
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: `解析中にエラーが発生しました: ${err.message}` });
  }
};

function parseVisionResult(apiResult, context) {
  const annotation = apiResult?.fullTextAnnotation;
  if (!annotation || !annotation.pages?.length) {
    return "テキストが検出されませんでした。画像を確認してください。";
  }

  const page = annotation.pages[0];
  const imgW = page.width;
  const imgH = page.height;

  const blocks = extractBlocks(page);
  blocks.sort((a, b) => a.topY - b.topY);

  const headerBottom = imgH * 0.11;
  const inputBarTop = imgH * 0.88;

  const partnerName = detectPartnerName(blocks, imgW, headerBottom, context);

  const chatBlocks = blocks.filter(
    (b) => b.topY >= headerBottom && b.bottomY <= inputBarTop
  );

  const elements = classifyBlocks(chatBlocks, imgW, imgH, partnerName);
  associateTimestamps(elements);
  detectGroupSenders(elements);

  return formatOutput(partnerName, elements);
}

function extractBlocks(page) {
  const result = [];
  if (!page.blocks) return result;

  for (const block of page.blocks) {
    if (block.blockType && block.blockType !== "TEXT") continue;
    if (!block.boundingBox?.vertices) continue;

    const v = block.boundingBox.vertices;
    const leftX = Math.min(v[0]?.x ?? 0, v[3]?.x ?? 0);
    const rightX = Math.max(v[1]?.x ?? 0, v[2]?.x ?? 0);
    const topY = Math.min(v[0]?.y ?? 0, v[1]?.y ?? 0);
    const bottomY = Math.max(v[2]?.y ?? 0, v[3]?.y ?? 0);

    const text = extractTextFromBlock(block);
    if (!text) continue;

    result.push({
      text,
      leftX,
      rightX,
      topY,
      bottomY,
      centerX: (leftX + rightX) / 2,
      width: rightX - leftX,
      height: bottomY - topY,
    });
  }
  return result;
}

function extractTextFromBlock(block) {
  let text = "";
  for (const para of block.paragraphs || []) {
    for (const word of para.words || []) {
      for (const symbol of word.symbols || []) {
        text += symbol.text || "";
        const bp = symbol.property?.detectedBreak?.type;
        if (bp === "SPACE" || bp === "SURE_SPACE") text += " ";
        else if (bp === "EOL_SURE_SPACE" || bp === "LINE_BREAK") text += "\n";
      }
    }
  }
  return text.trim();
}

function detectPartnerName(blocks, imgW, headerBottom, context) {
  if (context) return context;

  const headerBlocks = blocks.filter(
    (b) =>
      b.topY < headerBottom &&
      b.centerX > imgW * 0.25 &&
      b.centerX < imgW * 0.75 &&
      b.text.length > 1 &&
      !b.text.match(/^\d{1,2}:\d{2}$/) &&
      !b.text.match(/^[<←▼≡☰]/)
  );

  if (headerBlocks.length > 0) {
    headerBlocks.sort((a, b) => b.width - a.width);
    return headerBlocks[0].text.replace(/\n/g, " ").trim();
  }
  return "相手";
}

function classifyBlocks(chatBlocks, imgW, imgH, partnerName) {
  const elements = [];
  let currentDate = "--/--/--";

  for (const block of chatBlocks) {
    const text = block.text;

    if (text.match(/^既読\s*\d*$/) || text === "既読") continue;

    const dateResult = tryParseDate(text, block, imgW);
    if (dateResult) {
      currentDate = dateResult;
      elements.push({ type: "date", date: currentDate });
      continue;
    }

    const timeMatch = text.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch && block.height < imgH * 0.04) {
      elements.push({
        type: "time",
        time: `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`,
        topY: block.topY,
        bottomY: block.bottomY,
        centerX: block.centerX,
        leftX: block.leftX,
        rightX: block.rightX,
      });
      continue;
    }

    const side = classifySide(block, imgW);
    if (side === "center") continue;

    const sender = side === "right" ? "自分" : partnerName;

    let msgText = text;
    const trailingTime = msgText.match(/\n?(\d{1,2}:\d{2})$/);
    let extractedTime = null;
    if (trailingTime) {
      extractedTime = trailingTime[1];
      msgText = msgText.slice(0, -trailingTime[0].length).trim();
    }

    if (!msgText) continue;

    elements.push({
      type: "message",
      sender,
      text: msgText,
      date: currentDate,
      time: extractedTime
        ? `${extractedTime.split(":")[0].padStart(2, "0")}:${extractedTime.split(":")[1]}`
        : "--:--",
      topY: block.topY,
      bottomY: block.bottomY,
      centerX: block.centerX,
      leftX: block.leftX,
      rightX: block.rightX,
      side,
    });
  }

  return elements;
}

function tryParseDate(text, block, imgW) {
  if (!isCenter(block, imgW)) return null;

  let m = text.match(/(\d{4})[年\/](\d{1,2})[月\/](\d{1,2})/);
  if (m) return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;

  m = text.match(/(\d{1,2})[\/月](\d{1,2})/);
  if (m && text.match(/[月火水木金土日]/)) {
    const now = new Date();
    return `${now.getFullYear()}/${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}`;
  }

  return null;
}

function isCenter(block, imgW) {
  return block.centerX > imgW * 0.3 && block.centerX < imgW * 0.7 && block.width < imgW * 0.6;
}

function classifySide(block, imgW) {
  const rightMargin = imgW - block.rightX;
  const leftMargin = block.leftX;

  if (rightMargin < imgW * 0.08) return "right";
  if (leftMargin < imgW * 0.18) return "left";

  if (block.centerX > imgW * 0.6) return "right";
  if (block.centerX < imgW * 0.4) return "left";

  return "center";
}

function associateTimestamps(elements) {
  const messages = elements.filter((e) => e.type === "message");
  const timestamps = elements.filter((e) => e.type === "time");

  for (const ts of timestamps) {
    const tsMidY = (ts.topY + ts.bottomY) / 2;
    let nearest = null;
    let minDist = Infinity;

    for (const msg of messages) {
      if (msg.time !== "--:--") continue;
      const msgMidY = (msg.topY + msg.bottomY) / 2;
      const dist = Math.abs(tsMidY - msgMidY);
      if (dist < minDist) {
        minDist = dist;
        nearest = msg;
      }
    }

    if (nearest && minDist < nearest.bottomY - nearest.topY + 30) {
      nearest.time = ts.time;
    }
  }
}

function detectGroupSenders(elements) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.type !== "message" || el.side !== "left") continue;

    if (i > 0) {
      const prev = elements[i - 1];
      if (
        prev.type === "message" &&
        prev.side === "left" &&
        prev.text.length < 20 &&
        !prev.text.includes("\n") &&
        prev.bottomY - prev.topY < (el.bottomY - el.topY) * 0.6
      ) {
        el.sender = prev.text;
        prev.type = "sender_label";
      }
    }
  }
}

function formatOutput(partnerName, elements) {
  let output = `トーク相手: ${partnerName}\n\n`;
  let lastDate = null;

  for (const el of elements) {
    if (el.type === "date") {
      output += `--- ${el.date} ---\n`;
      lastDate = el.date;
    } else if (el.type === "message") {
      const date = el.date || lastDate || "--/--/--";
      output += `【${el.sender}】${el.text}（${date} ${el.time}）\n`;
    }
  }

  return output.trim();
}
