// Browsing (GET /), buying (POST /:id/buy — the only place moles get
// spent), and fulfillment (POST /orders/:id/fulfillment) — shipping info
// forwarded straight to Airtable, never persisted (PII, see CLAUDE.md rule 1).

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { orders, shopItems, transactions, users } from "../db/schema.js";
import { requireAuth, type SessionContext } from "../lib/session.js";
import { createRecord } from "../integrations/airtable.js";
import { checkEligibilityLive } from "../lib/eligibility-check.js";
import { config } from "../config.js";

// Explicit allowlist, same reasoning as projectColumns in projects.ts.
const shopItemColumns = {
  id: shopItems.id,
  name: shopItems.name,
  description: shopItems.description,
  imageUrl: shopItems.imageUrl,
  category: shopItems.category,
  priceMoles: shopItems.priceMoles,
};

const orderColumns = {
  id: orders.id,
  quantity: orders.quantity,
  pricePaid: orders.pricePaid,
  createdAt: orders.createdAt,
};

// Capped at 20 as defense-in-depth, not a real product constraint.
const buySchema = z.object({
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});

const fulfillmentSchema = z.object({
  fullName: z.string().trim().min(1).max(200).regex(/^[A-Za-z ]+$/, "Only letters and spaces are allowed"),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  stateProvince: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100),
  zip: z.string().trim().min(1).max(20),
  phone: z.string().trim().min(1).max(30),
  notes: z.string().trim().max(1000).optional(),
});

export const shopRoutes = new Hono<SessionContext>();

// No ownership filter — items aren't owned by a user. Only "active" ones show.
shopRoutes.get("/", async (c) => {
  const rows = await db.select(shopItemColumns).from(shopItems).where(eq(shopItems.active, true));
  return c.json(rows);
});

shopRoutes.get("/orders", requireAuth, async (c) => {
  const user = c.get("user")!;

  const rows = await db
    .select({ ...orderColumns, itemName: shopItems.name })
    .from(orders)
    .innerJoin(shopItems, eq(orders.shopItemId, shopItems.id))
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.createdAt));

  return c.json(rows);
});

shopRoutes.post("/:id/buy", requireAuth, async (c) => {
  const user = c.get("user")!;
  const shopItemId = c.req.param("id");
  if (!shopItemId) {
    return c.json({ error: "not_found" }, 404);
  }

  // Live re-check, not just relying on the value from login — see the
  // identical check in routes/projects.ts's handleSubmission for why.
  const blockReason = await checkEligibilityLive(user);
  if (blockReason) {
    return c.json({ error: "not_eligible", reason: blockReason }, 403);
  }

  // Parsed by hand, not zValidator — a missing body should default
  // quantity to 1, not 400.
  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = buySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json({ error: "Invalid quantity" }, 400);
  }
  const { quantity } = parsedBody.data;

  // One transaction — without it, two concurrent "buy" clicks could both
  // read a sufficient balance before either deducts, double-spending.
  const result = await db.transaction(async (tx) => {
    // Row lock — a concurrent "buy" for the same user waits here until
    // this transaction finishes.
    const [lockedUser] = await tx
      .select({ id: users.id, molesBalance: users.molesBalance })
      .from(users)
      .where(eq(users.id, user.id))
      .for("update");

    const [item] = await tx
      .select({ id: shopItems.id, name: shopItems.name, priceMoles: shopItems.priceMoles })
      .from(shopItems)
      // Re-checked here too — admin could deactivate the item between page load and click.
      .where(and(eq(shopItems.id, shopItemId), eq(shopItems.active, true)));

    if (!item) {
      return { error: "not_found" as const };
    }

    const totalPrice = item.priceMoles * quantity;

    if (lockedUser.molesBalance < totalPrice) {
      return { error: "insufficient_balance" as const };
    }

    const [order] = await tx
      .insert(orders)
      .values({
        userId: user.id,
        shopItemId: item.id,
        quantity,
        // Snapshots the TOTAL price paid, so a later Airtable price change
        // doesn't rewrite this order's history.
        pricePaid: totalPrice,
      })
      .returning(orderColumns);

    // reason is human-readable (shown in the ledger UI); refId carries the
    // real order id for anything that needs to look it up programmatically.
    await tx.insert(transactions).values({
      userId: user.id,
      type: "spent",
      amount: totalPrice,
      reason: quantity > 1 ? `Bought ${quantity}× ${item.name}` : `Bought ${item.name}`,
      refId: order.id,
    });

    await tx
      .update(users)
      .set({ molesBalance: lockedUser.molesBalance - totalPrice })
      .where(eq(users.id, user.id));

    return { order: { ...order, itemName: item.name } };
  });

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return c.json({ error: result.error }, status);
  }

  return c.json(result.order, 201);
});

shopRoutes.post(
  "/orders/:id/fulfillment",
  requireAuth,
  // No file upload here (unlike the submission form) — 100KB is
  // defense-in-depth, not a real cap.
  bodyLimit({ maxSize: 100 * 1024 }),
  zValidator("json", fulfillmentSchema),
  async (c) => {
    const user = c.get("user")!;
    const orderId = c.req.param("id");
    if (!orderId) {
      return c.json({ error: "Not found" }, 404);
    }
    const input = c.req.valid("json");

    // Must belong to this user — prevents submitting shipping info against
    // a guessed order id.
    const [order] = await db
      .select({ id: orders.id, itemName: shopItems.name, quantity: orders.quantity, pricePaid: orders.pricePaid })
      .from(orders)
      .innerJoin(shopItems, eq(orders.shopItemId, shopItems.id))
      .where(and(eq(orders.id, orderId), eq(orders.userId, user.id)));

    if (!order) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      // Field names below match the real "fulfilment" table (one L) built
      // by hand in Airtable:
      //  - both a combined "address" field and separate Address Line
      //    1/2/city/etc. fields exist — we write both, the combined one
      //    purely so the admin can see a whole address at a glance.
      //  - both a "Fullfiled?" checkbox and a "fulfillment status" select
      //    exist — we only ever set the select.
      //  - never persisted in Postgres — the whole point of this endpoint.
      await createRecord(config.airtable.fulfillmentTableId, {
        // No "Order ID" field on the real table (confirmed via metadata
        // API) — sending one made every submission fail with an
        // unknown-field error.
        item_name: order.quantity > 1 ? `${order.quantity}x ${order.itemName}` : order.itemName,
        "Full Name": input.fullName,
        // Account email, not client input — the whole point is that this can't be typo'd/spoofed.
        Email: user.email,
        slack_id: user.slackId,
        currency_spent: "moles",
        amount: order.pricePaid,
        "Address Line 1": input.addressLine1,
        "Address Line 2": input.addressLine2 ?? "",
        city: input.city,
        "State/Province": input.stateProvince,
        Country: input.country,
        "Postal/ZIP Code": input.zip,
        address: [input.addressLine1, input.addressLine2, input.city, input.stateProvince, input.zip, input.country]
          .filter(Boolean)
          .join(", "),
        phone_number: input.phone,
        // Real options are ordered/not fulfilled/delivered/issue, NOT
        // "pending" — Airtable rejects unrecognized select values outright
        // (422), which silently broke every submission until this was caught.
        "fulfillment status": "not fulfilled",
        // Distinct from the pre-existing "notes" field (internal/fulfiller-facing) —
        // this one is what the buyer typed, added specifically for that purpose.
        "user order notes": input.notes ?? "",
      });
    } catch (err) {
      console.error("Airtable fulfillment failed", err instanceof Error ? err.message : err);
      return c.json({ error: "Could not record fulfillment, please try again" }, 502);
    }

    return c.body(null, 204);
  },
);
