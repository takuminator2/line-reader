const Anthropic = require("@anthropic-ai/sdk").default;

const SYSTEM_PROMPT = `あなたはLINEのスクリーンショットを解析する専門アシスタントです。
画像からすべてのメッセージを正確に読み取り、以下のルールに従って出力してください。

## LINEのUI構造
- 右側の吹き出し（緑色/青色）= スクリーンショットを撮った本人のメッセージ
- 左側の吹き出し（白色/灰色）= 相手のメッセージ
- グループトークの場合、左側の吹き出しの上に送信者名が表示される
- アイコン画像が吹き出しの横に表示されることがある
- タイムスタンプが吹き出しの横に小さく表示される
- 「既読」マークが表示されることがある

## 出力ルール
1. 画面上部のトーク相手の名前やグループ名を最初に記載する
2. メッセージは画面の上から順番に出力する
3. 各メッセージは以下の形式で出力する：
   【送信者名】メッセージ内容（YYYY/MM/DD HH:MM）
4. 日付の区切り線（例: 「2024年6月15日(土)」「6/15(土)」など）が画面に表示されている場合、その日付をそれ以降のメッセージに適用する
5. 日付の区切り線が画面内に見えない場合でも、スマホのステータスバーやヘッダーの日付情報があれば推測して記載する。日付が完全に不明な場合は日付部分を「--/--/--」とする
6. 右側の吹き出し（本人のメッセージ）は送信者名を「自分」とする
7. 1対1トークで相手の名前が画面上部に表示されている場合、その名前を送信者名とする
8. スタンプや画像の場合は [スタンプ] や [画像] と記載する
9. 改行を含むメッセージはそのまま改行を保持する

## 出力例
トーク相手: 田中太郎

--- 2024/06/15 ---
【田中太郎】今日の会議何時からだっけ？（2024/06/15 14:02）
【自分】15時からだよ（2024/06/15 14:03）
【自分】会議室Bで（2024/06/15 14:03）
【田中太郎】了解！（2024/06/15 14:05）
【田中太郎】[スタンプ]（2024/06/15 14:05）
--- 2024/06/16 ---
【自分】昨日はありがとう（2024/06/16 09:10）
---

正確に、漏れなく読み取ってください。読み取れない文字がある場合は [判読不能] と記載してください。`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(400).json({ error: "APIキーが設定されていません" });
  }

  const { image, mediaType } = req.body;
  if (!image) {
    return res.status(400).json({ error: "画像がアップロードされていませんでした" });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            {
              type: "text",
              text: "このLINEのスクリーンショットからすべてのメッセージを読み取り、指定のフォーマットで出力してください。",
            },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ result: text });
  } catch (err) {
    const msg =
      err.status === 401
        ? "APIキーが無効です。正しいキーを入力してください。"
        : `解析中にエラーが発生しました: ${err.message}`;
    res.status(err.status || 500).json({ error: msg });
  }
};
