import { Hono } from "hono";
import { db } from "../db/index";
import { vccCards, vccTransactions, accounts } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";

const vccRouter = new Hono();

vccRouter.get("/pool", async (c) => {
  const cards = await db
    .select()
    .from(vccCards)
    .where(eq(vccCards.status, "active"));

  return c.json({
    count: cards.length,
    cards: cards.map((card) => ({
      id: card.id,
      last4: card.number.slice(-4),
      exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
      name: card.name || "John Doe",
      status: card.status,
      createdAt: card.createdAt,
    })),
  });
});

vccRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ cards: { number: string; exp: string; cvv: string; name?: string }[] }>();
  if (!Array.isArray(body.cards)) {
    return c.json({ error: "cards must be an array" }, 400);
  }

  let added = 0;
  for (const card of body.cards) {
    if (!card.number || !card.exp || !card.cvv) continue;

    const number = card.number.replace(/[\s-]/g, "");
    let expMonth = "";
    let expYear = "";

    if (card.exp.includes("/")) {
      const parts = card.exp.split("/");
      expMonth = parts[0]!.trim().padStart(2, "0");
      expYear = parts[1]!.trim();
      if (expYear.length === 2) expYear = `20${expYear}`;
    }

    await db.insert(vccCards).values({
      number,
      expMonth,
      expYear,
      cvv: card.cvv,
      name: card.name || "John Doe",
      status: "active",
    });
    added++;
  }

  return c.json({ added });
});

vccRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

  await db.delete(vccCards).where(eq(vccCards.id, id));
  return c.json({ deleted: true });
});

vccRouter.delete("/pool", async (c) => {
  await db.delete(vccCards).where(eq(vccCards.status, "active"));
  return c.json({ cleared: true });
});

vccRouter.get("/transactions", async (c) => {
  const rows = await db
    .select({
      id: vccTransactions.id,
      accountId: vccTransactions.accountId,
      cardLast4: vccTransactions.cardLast4,
      cardBrand: vccTransactions.cardBrand,
      status: vccTransactions.status,
      createdAt: vccTransactions.createdAt,
      email: accounts.email,
    })
    .from(vccTransactions)
    .leftJoin(accounts, eq(vccTransactions.accountId, accounts.id))
    .orderBy(desc(vccTransactions.createdAt))
    .limit(100);

  return c.json({ transactions: rows });
});

export function getVccPool(): { number: string; exp: string; cvv: string; name: string }[] {
  return [];
}

export async function getVccPoolFromDb(): Promise<{ number: string; exp: string; cvv: string; name: string }[]> {
  const activeCards = await db.select().from(vccCards).where(eq(vccCards.status, "active"));

  const cards = activeCards.map((card) => ({
    number: card.number,
    exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
    cvv: card.cvv,
    name: card.name || "John Doe",
  }));

  // Shuffle to avoid race conditions in concurrent processes
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }

  return cards;
}

export async function reserveCardForAccount(accountId: number): Promise<{ number: string; exp: string; cvv: string; name: string } | null> {
  const [card] = await db.select().from(vccCards).where(eq(vccCards.status, "active")).limit(1);
  if (!card) return null;

  await db.update(vccCards).set({
    status: "reserved",
    usedByAccountId: accountId,
    updatedAt: new Date(),
  }).where(eq(vccCards.id, card.id));

  return {
    number: card.number,
    exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
    cvv: card.cvv,
    name: card.name || "John Doe",
  };
}

export async function releaseReservedCard(accountId: number): Promise<void> {
  await db.update(vccCards).set({
    status: "active",
    usedByAccountId: null,
    updatedAt: new Date(),
  }).where(eq(vccCards.usedByAccountId, accountId));
}

export async function handleCardResult(
  accountId: number,
  cardLast4: string,
  status: "success" | "declined" | "error"
): Promise<void> {
  const allCards = await db.select().from(vccCards);
  const match = allCards.find((c) => c.number.endsWith(cardLast4));
  if (match) {
    if (status === "declined") {
      await db.delete(vccCards).where(eq(vccCards.id, match.id));
    } else {
      const newStatus = status === "success" ? "used" : match.status;
      await db
        .update(vccCards)
        .set({
          status: newStatus,
          usedByAccountId: accountId,
          updatedAt: new Date(),
        })
        .where(eq(vccCards.id, match.id));
    }
  }

  await db.insert(vccTransactions).values({
    accountId,
    cardLast4,
    amount: 0,
    currency: "usd",
    status,
  });
}

export { vccRouter };
