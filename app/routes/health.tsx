/**
 * Fly.io's HTTP health check target (see fly.toml). Deliberately does
 * nothing but confirm the process is up and listening — no auth, no
 * database call — so it reflects "ready to receive traffic" as fast as
 * possible right after a machine starts, without racing Prisma's
 * connection warm-up. fly-proxy only routes real requests (including
 * Shopify webhook deliveries) to a machine once this passes, closing
 * the brief window during a rolling deploy where a machine had
 * started but wasn't listening yet.
 */
export const loader = () => {
  return new Response("ok", {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
    },
  });
};
