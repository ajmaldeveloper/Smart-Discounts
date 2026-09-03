import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// This app is embedded-only — there's no standalone marketing/login
// page to show here, so every visit to the bare root goes straight to
// the embedded app. /app's own loader (authenticate.admin) handles the
// OAuth bounce for a request with no active session.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};
