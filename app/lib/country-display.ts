const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

export function countryFlagEmoji(countryCode: string): string {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(...[...code].map((char) => 127397 + char.charCodeAt(0)));
}

export function countryDisplayName(countryCode: string): string {
  try {
    return REGION_NAMES.of(countryCode.trim().toUpperCase()) ?? countryCode;
  } catch {
    return countryCode;
  }
}
