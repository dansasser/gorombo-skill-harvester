const IDENTITY = /^[1-9][0-9]{0,19}$/u;

export function normalizeTelegramIdentity(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !IDENTITY.test(text)) throw new Error("telegram_identity_invalid");
  return text;
}
