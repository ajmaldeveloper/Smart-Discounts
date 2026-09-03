export function currencySymbol(currencyCode: string): string {
  try {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? currencyCode;
  } catch {
    return currencyCode;
  }
}
