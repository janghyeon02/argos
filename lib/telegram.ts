// 텔레그램 봇으로 메시지를 보낸다 (별도 도구 없이 HTTP 요청만 사용 — DESIGN 3.1).
// 키는 .env의 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID에서 읽고 화면에 출력하지 않는다.

export function telegramReady(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
}

export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 비어 있습니다");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // 오류 설명만 남기고 주소(토큰 포함)는 남기지 않는다
    const detail = await response.json().catch(() => ({}) as { description?: string });
    throw new Error(`텔레그램 발송 실패 (${response.status}): ${(detail as { description?: string }).description ?? "알 수 없음"}`);
  }
}
