import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getActiveAbTest } from "../services/storefront-widgets.server";

/**
 * Backs public/widgets/ab-test-bootstrap.js — tells it what percent of
 * shoppers to bucket into Variant A right now (or that there's no
 * active experiment at all, in which case the script does nothing).
 * The actual random assignment happens client-side and is written to
 * a cart attribute; the checkout Function reads that attribute — see
 * extensions/winslet-discounts/src/cart_lines_discounts_generate_run.ts.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  return Response.json(await getActiveAbTest(shop.id));
};
