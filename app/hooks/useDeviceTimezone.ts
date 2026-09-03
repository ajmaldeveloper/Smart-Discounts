import { useEffect, useState } from "react";

/**
 * The merchant's own device/browser timezone — not the shop's
 * configured one. SSR has no concept of "the merchant's device" (the
 * server's own system zone has nothing to do with it), so this starts
 * at `fallback` for the server-rendered pass and corrects to the
 * browser's real IANA timezone immediately after mount.
 */
export function useDeviceTimezone(fallback: string): string {
  const [timezone, setTimezone] = useState(fallback);

  useEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) setTimezone(resolved);
    // Mount-only: this reflects the device the merchant is on right now, not something that should re-run as other state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return timezone;
}
