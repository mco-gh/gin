// The computer opponent. It stands in for net.js's link: the page talks to it
// exactly as it would to a guest's browser, and it answers with the same
// messages, so the match itself runs unchanged. It keeps its own copy of the
// match, as a guest would, and only ever looks at what a player at the table
// could see: its own cards, the pile, and what you've picked up and thrown.
import * as Gin from './gin.js';

export const LEVELS = {
  // Grabs any pile card that makes a meld, and often throws the wrong card.
  easy: { name: 'Easy', slip: 0.35, pile: 'melds' },
  // Keeps its deadwood low, only takes from the pile when it pays, and now and then slips.
  medium: { name: 'Medium', slip: 0.12, pile: 'smart' },
  // Never slips, and holds on to cards that could still make melds, counting only
  // the cards that haven't turned up yet.
  hard: { name: 'Hard', slip: 0, pile: 'smart', potential: 1, live: true },
};

/** Same shape as openLink() in net.js. */
export function openBot({ level, on, seat = 1 }) {
  const skill = LEVELS[level] ?? LEVELS.medium;
  const me = seat;              // the host is player 0, so the computer is 1
  let match = null;
  let seen = null;              // what we know of their cards: { took: Set }
  let timer = 0;
  let closed = false;

  const reply = (message) => { if (!closed) on.message?.(message); };
  const aces = () => Gin.acesRule(match?.aces);

  /** Note what the other player just did. */
  function watch() {
    const last = match?.hand?.last;
    if (!last || last.who === me) return;
    if (last.act === 'pile' && last.card !== null) seen.took.add(last.card);
    if (last.drew !== null && last.drew !== undefined) seen.took.add(last.drew);
    if (last.act === 'discard' || last.act === 'gin') seen.took.delete(last.card);
  }

  function act(action) {
    if (!match || !Gin.canAct(match, me)) return;
    const ok = action.act === 'take' ? Gin.take(match, action.from)
      : action.act === 'pass' ? Gin.pass(match)
      : Gin.discard(match, action.card);
    if (ok) reply({ t: 'act', ...action });
  }

  function think() {
    clearTimeout(timer);
    const hand = match?.hand;
    if (closed || !hand) return;
    if (hand.phase === 'done') {
      // Ready for the next hand (or a new game) after a moment to look at the result.
      timer = setTimeout(() => { if (!closed) reply({ t: 'ready', over: match.winner !== null }); }, 1500);
      return;
    }
    if (!Gin.canAct(match, me)) return;
    timer = setTimeout(() => {
      if (closed || !Gin.canAct(match, me)) return;
      const cards = hand.hands[me];
      if (hand.phase === 'offer') act(wantsPile(cards, hand.pile.at(-1)) ? { act: 'take', from: 'pile' } : { act: 'pass' });
      else if (hand.phase === 'draw') {
        const top = hand.pile.at(-1);
        act(!hand.stockOnly && top !== undefined && wantsPile(cards, top) ? { act: 'take', from: 'pile' } : { act: 'take', from: 'stock' });
      } else if (hand.phase === 'discard') act({ act: 'discard', card: chooseDiscard(cards) });
      think();
    }, hand.phase === 'discard' ? 700 + Math.random() * 700 : 900 + Math.random() * 900);
  }

  // ── Deciding ───────────────────────────────────────────────────────────────

  /** Take the pile's top card? Only if it goes straight into a meld. */
  function wantsPile(cards, card) {
    if (card === undefined) return false;
    const now = Gin.bestMelds(cards, aces());
    const withIt = [...cards, card];
    const best = Gin.bestMelds(withIt, aces());
    if (!best.melds.flat().includes(card)) return false;
    if (skill.pile === 'melds') return true;
    // It must leave us better off once we've thrown something else.
    const throwAway = chooseDiscard(withIt, card);
    return Gin.deadwoodWithout(withIt, throwAway, aces()) < now.points;
  }

  /** Which card to throw: the one we'll miss least. Never `keep`. */
  function chooseDiscard(cards, keep = null) {
    const options = cards.filter((card) => card !== keep);
    const gin = options.find((card) => Gin.ginWithout(cards, card, aces()));
    if (gin !== undefined) return gin;
    const scored = options.map((card) => ({ card, cost: cost(cards, card) })).sort((a, b) => a.cost - b.cost);
    if (skill.slip && scored.length > 2 && Math.random() < skill.slip) return scored[1 + Math.floor(Math.random() * 2)].card;
    return scored[0].card;
  }

  /** How bad it would be to throw `card`: what the hand it leaves is worth. */
  function cost(cards, card) {
    const rest = cards.filter((c) => c !== card);
    const { melds, deadwood, points } = Gin.bestMelds(rest, aces());
    let total = points;
    if (skill.potential) {
      // Unmelded cards that could still become melds are worth keeping.
      for (const c of deadwood) total -= skill.potential * chances(c, rest, melds);
    }
    return total;
  }

  /** How many ways this deadwood card could join a meld, counting only cards still unseen. */
  function chances(card, cards, melds) {
    const r = Gin.rank(card);
    const s = Gin.suit(card);
    const have = (c) => cards.includes(c);
    const out = (c) => !skill.live || (!match.hand.pile.includes(c) && !seen.took.has(c));
    const at = (rank, st) => (rank >= 1 && rank <= 13 ? st * 13 + rank - 1 : null);
    let ways = 0;
    // Same rank: a pair needs one more; a meld's rank can take a fourth.
    const sameRank = [0, 1, 2, 3].map((st) => at(r, st)).filter((c) => c !== card);
    if (sameRank.some(have)) ways += sameRank.filter((c) => !have(c) && out(c)).length / 2;
    // Same suit: neighbors that would make or extend a run (going round the ace if the rule allows).
    const step = (from, by) => {
      let x = from;
      for (let k = 0; k < Math.abs(by) && x !== null; k++) x = by > 0 ? Gin.nextRank(x, aces()) : Gin.prevRank(x, aces());
      return x;
    };
    const inSuit = (x) => (x === null ? null : s * 13 + x - 1);
    for (const d of [-2, -1, 1, 2]) {
      const other = step(r, d);
      if (other === null || !have(inSuit(other))) continue;
      const lo = d > 0 ? r : other;
      const hi = d > 0 ? other : r;
      const gap = Math.abs(d) === 2 ? [step(lo, 1)] : [step(lo, -1), step(hi, 1)];
      ways += gap.map(inSuit).filter((c) => c !== null && !have(c) && out(c)).length / 2;
    }
    // A card one gap away from a run we already have.
    for (const meld of melds) {
      if (!Gin.isRun(meld, aces()) || Gin.suit(card) !== Gin.suit(meld[0])) continue;
      for (const between of [step(r, 1), step(r, -1)].map(inSuit)) {
        if (between !== null && !have(between) && Gin.isRun([...meld, between, card], aces())) { ways += 0.5; break; }
      }
    }
    return ways;
  }

  setTimeout(() => { if (!closed) on.open?.(); }, 0);

  return {
    connected: true,
    send(message) {
      switch (message?.t) {
        case 'sync': {
          // A copy, as if it had crossed the network.
          const fresh = message.match?.hand?.number !== match?.hand?.number || message.match?.hands.length < (match?.hands.length ?? 0);
          match = structuredClone(message.match);
          if (fresh || !seen) seen = { took: new Set() };
          return think();
        }
        case 'act': {
          if (!match || !Gin.canAct(match, 1 - me)) return reply({ t: 'resync' });
          const ok = message.act === 'take' ? Gin.take(match, message.from)
            : message.act === 'pass' ? Gin.pass(match)
            : message.act === 'discard' ? Gin.discard(match, message.card)
            : false;
          if (!ok) return reply({ t: 'resync' });
          watch();
          return think();
        }
      }
    },
    setMedia() {},
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
