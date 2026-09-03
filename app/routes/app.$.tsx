import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

// Catches any /app/* path that doesn't match a real route (a stale
// bookmark, an old link to a renamed/removed page, a typo) — without
// this, react-router's own bare "404" page renders inside the embedded
// admin frame instead of somewhere the merchant can actually use.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
