import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtUser, isPrivileged } from '../auth/role.enum';

export interface CreateCardInput {
  cardName: string;
  cardholderName?: string;
  maskedNumber: string;
  last4?: string;
  assignedUserId?: string;
  creditLimit?: number | null;
}

export interface UpdateCardInput {
  cardName?: string;
  cardholderName?: string;
  maskedNumber?: string;
  last4?: string;
  assignedUserId?: string | null;
  creditLimit?: number | null;
}

// Statement parsers sometimes hand us last4 with stray whitespace
// ("  5678  "), as a number padded short ("78" instead of "0078"),
// or with format chars ("**5678"). Normalise here so the unique
// constraint on Card.last4 actually catches duplicates instead of
// silently letting two near-identical rows coexist.
export function normaliseLast4(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Strip everything but digits (drops *, spaces, dashes, etc.)
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 0) return null;
  // Keep only the trailing 4 digits — handles cases where the input is
  // the full number ("4228247xxxx5678" → "5678").
  const tail = digits.slice(-4);
  // Left-pad to 4 (rare, but defensive: "78" → "0078").
  return tail.padStart(4, '0');
}

// Masked numbers come in many shapes from different banks. We collapse
// internal whitespace and uppercase so "4228 24** **** 5678" and
// "4228 24**  ****  5678" don't end up as two separate cards.
export function normaliseMaskedNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/\s+/g, ' ').trim().toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

@Injectable()
export class CardsService {
  constructor(private prisma: PrismaService) {}

  // List cards visible to the caller:
  //   USER       → only cards where assignedUserId = currentUser
  //   REPORTING  → all cards
  //   ADMIN      → all cards
  async getCards(currentUser: JwtUser) {
    const cards = await this.prisma.card.findMany({
      where: isPrivileged(currentUser.role)
        ? undefined
        : { assignedUserId: currentUser.sub },
      orderBy: { createdAt: 'desc' },
    });

    // Prisma doesn't have a clean way to do _count + relation in one
    // query when the relation is via a string field (cardLast4), so we
    // do a second query and merge. Cheap enough for hundreds of cards.
    const assignedUserIds = cards
      .map((c) => c.assignedUserId)
      .filter((id): id is string => id !== null);

    const users = assignedUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: assignedUserIds } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const last4s = cards
      .map((c) => c.last4)
      .filter((l): l is string => l !== null);

    const txCounts = last4s.length
      ? await this.prisma.transaction.groupBy({
          by: ['cardLast4'],
          where: { cardLast4: { in: last4s } },
          _count: { _all: true },
        })
      : [];
    const countByLast4 = new Map(
      txCounts.map((t) => [t.cardLast4 ?? '', t._count._all]),
    );

    return cards.map((c) => ({
      ...c,
      assignedUser: c.assignedUserId
        ? userById.get(c.assignedUserId) ?? null
        : null,
      transactionCount: c.last4 ? countByLast4.get(c.last4) ?? 0 : 0,
    }));
  }

  // getCardById has two callers:
  //   - controllers (with a currentUser to enforce visibility)
  //   - internal callers (other services that just need the row)
  // The `currentUser` parameter is optional so internal callers can omit it.
  async getCardById(id: string, currentUser?: JwtUser) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException(`Card ${id} not found`);

    // Enforce visibility when called from HTTP context.
    if (
      currentUser &&
      !isPrivileged(currentUser.role) &&
      card.assignedUserId !== currentUser.sub
    ) {
      // Don't leak existence — return same 404 as missing.
      throw new NotFoundException(`Card ${id} not found`);
    }
    return card;
  }

  async createCard(data: CreateCardInput) {
    // Normalise before storing so future dedup lookups (and the DB
    // unique constraint on last4) compare apples to apples.
    const last4 = normaliseLast4(data.last4 ?? null);
    const maskedNumber = normaliseMaskedNumber(data.maskedNumber);
    if (!maskedNumber) {
      throw new BadRequestException('maskedNumber is required');
    }

    // Pre-check duplicates by last4 OR maskedNumber for a clean 409
    // instead of letting Prisma's P2002 bubble out as a 500.
    if (last4) {
      const dupByLast4 = await this.prisma.card.findUnique({
        where: { last4 },
        select: { id: true, cardName: true },
      });
      if (dupByLast4) {
        throw new ConflictException(
          `A card ending ${last4} already exists ("${dupByLast4.cardName}"). Edit it instead.`,
        );
      }
    }
    const dupByMasked = await this.prisma.card.findFirst({
      where: { maskedNumber },
      select: { id: true, cardName: true },
    });
    if (dupByMasked) {
      throw new ConflictException(
        `A card with that masked number already exists ("${dupByMasked.cardName}"). Edit it instead.`,
      );
    }

    return this.prisma.card.create({
      data: {
        ...data,
        last4,
        maskedNumber,
      },
    });
  }

  async updateCard(id: string, data: UpdateCardInput) {
    await this.getCardById(id); // internal call — no user check

    // Same normalisation on update so admin edits can't reintroduce
    // a near-duplicate by trailing whitespace etc.
    const next: UpdateCardInput = { ...data };
    if (data.last4 !== undefined) {
      next.last4 = normaliseLast4(data.last4) ?? undefined;
      // Block collisions with another card.
      if (next.last4) {
        const collision = await this.prisma.card.findFirst({
          where: { last4: next.last4, NOT: { id } },
          select: { id: true, cardName: true },
        });
        if (collision) {
          throw new ConflictException(
            `Another card already ends ${next.last4} ("${collision.cardName}").`,
          );
        }
      }
    }
    if (data.maskedNumber !== undefined) {
      next.maskedNumber = normaliseMaskedNumber(data.maskedNumber) ?? undefined;
    }
    return this.prisma.card.update({ where: { id }, data: next });
  }

  async deleteCard(id: string) {
    await this.getCardById(id);
    return this.prisma.card.delete({ where: { id } });
  }

  // Merge two cards: re-route every transaction from `losingId` to
  // `winningId`'s last4, then delete the loser. Use when statement
  // formatting created two rows for the same physical card.
  async mergeCards(winningId: string, losingId: string) {
    if (winningId === losingId) {
      throw new BadRequestException('Cannot merge a card with itself.');
    }
    const winning = await this.getCardById(winningId);
    const losing = await this.getCardById(losingId);
    if (!winning.last4) {
      throw new BadRequestException(
        'Cannot merge into a card with no last4.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Re-route any transactions still pointing at the loser's last4.
      if (losing.last4) {
        await tx.transaction.updateMany({
          where: { cardLast4: losing.last4 },
          data: { cardLast4: winning.last4 },
        });
      }
      // Delete the loser; transactions already moved.
      await tx.card.delete({ where: { id: losingId } });
      return tx.card.findUnique({ where: { id: winningId } });
    });
  }

  // Assign (or unassign) a user to a card.
  //
  // BUSINESS RULE: When we assign a user, every existing transaction on
  // that card's last4 gets retroactively re-attributed to the new owner
  // and the `flagged` review marker is cleared. This is what fixes the
  // PDF-import case where we attributed everything to the uploader.
  //
  // When we UNassign (userId = null), we don't reverse the transaction
  // attributions — there's nowhere clean to send them, and the admin
  // probably means "this card is being reassigned soon, not erased".
  async assignToUser(cardId: string, userId: string | null) {
    const card = await this.getCardById(cardId);

    // If this card has a last4, find all transactions linked by it and
    // wrap the card update + transaction re-route in a transaction so
    // we can never end up half-done.
    return this.prisma.$transaction(async (tx) => {
      const updatedCard = await tx.card.update({
        where: { id: cardId },
        data: { assignedUserId: userId },
      });

      // Only cascade the re-attribution when assigning, and only when
      // we have a last4 to look up transactions by.
      if (userId && card.last4) {
        await tx.transaction.updateMany({
          where: {
            cardLast4: card.last4,
            // Only re-route the ones still in "needs assignment" state.
            // Manually-tweaked transactions stay where they are.
            flagged: true,
          },
          data: {
            userId,
            flagged: false,
          },
        });
      }

      return updatedCard;
    });
  }

  // Live-spend tracker. For each card (scoped by role — USERs see only
  // their own, admins/reporting see the whole company), compute:
  //   - creditLimit         (from card, or null if not set)
  //   - lastCycleEnd        (max periodEnd of statements covering this card)
  //   - liveSpend           (sum of invoices dated AFTER lastCycleEnd,
  //                          net of refunds and wallet-credit applied)
  //   - available           (creditLimit - liveSpend, or null when no limit)
  //
  // The "since last cycle" model is what the user asked for: uploads
  // during the current billing cycle draw down the limit; the moment a
  // new statement is uploaded, lastCycleEnd moves forward and the
  // counter effectively resets.
  async getLiveSpend(currentUser: JwtUser) {
    const scopedToSelf = !isPrivileged(currentUser.role);
    const cardWhere = scopedToSelf
      ? { assignedUserId: currentUser.sub }
      : undefined;

    const cards = await this.prisma.card.findMany({
      where: cardWhere,
      orderBy: { cardName: 'asc' },
    });
    if (cards.length === 0) return [];

    // Look up the max statement periodEnd per card, keyed by last4.
    // Statements have a periodStart/periodEnd derived from the imported
    // transaction dates, so this genuinely reflects "the last billing
    // cycle we have on file for this card".
    const last4s = cards
      .map((c) => c.last4)
      .filter((l): l is string => !!l);
    const statementTails = await this.prisma.transaction.groupBy({
      by: ['cardLast4'],
      where: {
        cardLast4: { in: last4s },
        // Only look at transactions attached to a real statement — a
        // manually-created transaction shouldn't advance the cycle
        // boundary.
        statementId: { not: null },
      },
      _max: { transactionDate: true },
    });
    const cycleEndByLast4 = new Map<string, Date>();
    for (const row of statementTails) {
      if (row.cardLast4 && row._max.transactionDate) {
        cycleEndByLast4.set(row.cardLast4, row._max.transactionDate);
      }
    }

    // For each card compute liveSpend. We aggregate in JS because the
    // per-card window varies (each card can have a different
    // lastCycleEnd). Fine for the small number of cards a company has.
    const results = await Promise.all(
      cards.map(async (card) => {
        const cycleEnd = card.last4
          ? cycleEndByLast4.get(card.last4) ?? null
          : null;

        // If the card isn't assigned to a user yet we still show the
        // card but with liveSpend=0 — we don't know whose invoices to
        // count against it.
        const ownerId = card.assignedUserId;
        let liveSpend = 0;
        if (ownerId) {
          const invs = await this.prisma.invoice.findMany({
            where: {
              userId: ownerId,
              // Only invoices dated after the cycle ended — those are
              // the "in-progress" ones. Falls back to all invoices
              // when there's no prior statement (first cycle).
              ...(cycleEnd
                ? { invoiceDate: { gt: cycleEnd } }
                : {}),
            },
            select: {
              total: true,
              totalZAR: true,
              creditApplied: true,
              kind: true,
            },
          });
          for (const inv of invs) {
            const gross = inv.totalZAR ?? inv.total ?? 0;
            const effective = Math.max(
              0,
              gross - (inv.creditApplied ?? 0),
            );
            liveSpend += inv.kind === 'REFUND' ? -effective : effective;
          }
        }

        const available =
          card.creditLimit != null
            ? Math.max(0, card.creditLimit - liveSpend)
            : null;

        return {
          cardId: card.id,
          cardName: card.cardName,
          cardholderName: card.cardholderName,
          last4: card.last4,
          assignedUserId: card.assignedUserId,
          creditLimit: card.creditLimit,
          lastCycleEnd: cycleEnd ? cycleEnd.toISOString() : null,
          liveSpend,
          available,
        };
      }),
    );
    return results;
  }
}
