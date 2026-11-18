// The rules of gin rummy, with no knowledge of the page. Both browsers keep an
// identical copy of the game and apply the same actions to it, so every
// function here is deterministic: given the same deck and actions, both sides
// reach the same state.
//
// Cards are the numbers 0–51: suit = ⌊card / 13⌋, rank = card % 13 + 1 (ace low).

export const SUITS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_NAMES = ['', 'ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];

export const GIN_BONUS = 25;
export const GAME_BONUS = 100;
export const BOX_BONUS = 25;
export const TARGETS = [50, 100, 150];

export const rank = (card) => (card % 13) + 1;
export const suit = (card) => Math.floor(card / 13);
export const value = (card) => Math.min(rank(card), 10);
export const rankLabel = (card) => RANK_LABELS[rank(card)];
export const label = (card) => `${rankLabel(card)}${SUITS[suit(card)]}`;
export const cardName = (card) => `${RANK_NAMES[rank(card)]} of ${SUIT_NAMES[suit(card)]}`;
export const points = (cards) => cards.reduce((sum, card) => sum + value(card), 0);
export const isCard = (card) => Number.isInteger(card) && card >= 0 && card < 52;

/** A freshly shuffled deck, from the browser's secure random numbers. */
export function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, k) => k);
  for (let k = deck.length - 1; k > 0; k--) {
    const pick = crypto.getRandomValues(new Uint32Array(1))[0] % (k + 1);
    [deck[k], deck[pick]] = [deck[pick], deck[k]];
  }
  return deck;
}

export const isDeck = (deck) =>
  Array.isArray(deck) && deck.length === 52 && new Set(deck).size === 52 && deck.every(isCard);

// ── Melds ────────────────────────────────────────────────────────────────────
const byRank = (a, b) => rank(a) - rank(b) || suit(a) - suit(b);
const isSet = (meld) => meld.every((card) => rank(card) === rank(meld[0]));

/** Every set (3 or 4 of a rank) and run (3+ in a row, one suit) these cards can make. */
export function possibleMelds(cards) {
  const melds = [];
  const ranks = new Map();
  for (const card of cards) ranks.set(rank(card), [...(ranks.get(rank(card)) ?? []), card]);
  for (const group of ranks.values()) {
    if (group.length < 3) continue;
    group.sort(byRank);
    if (group.length === 3) melds.push(group);
    else {
      melds.push(group);
      for (let skip = 0; skip < 4; skip++) melds.push(group.filter((_, k) => k !== skip));
    }
  }
  for (let s = 0; s < 4; s++) {
    const have = new Set(cards.filter((card) => suit(card) === s).map(rank));
    for (let start = 1; start <= 11; start++) {
      const run = [];
      for (let r = start; r <= 13 && have.has(r); r++) {
        run.push(s * 13 + r - 1);
        if (run.length >= 3) melds.push(run.slice());
      }
    }
  }
  return melds;
}

/** Every way to pick non-overlapping melds from these cards (including none). */
function meldChoices(cards) {
  const melds = possibleMelds(cards);
  const choices = [];
  const walk = (from, used, chosen) => {
    choices.push(chosen);
    for (let k = from; k < melds.length; k++) {
      if (melds[k].some((card) => used.has(card))) continue;
      const next = new Set(used);
      for (const card of melds[k]) next.add(card);
      walk(k + 1, next, [...chosen, melds[k]]);
    }
  };
  walk(0, new Set(), []);
  return choices;
}

function arrangement(cards, melds) {
  const melded = new Set(melds.flat());
  const deadwood = cards.filter((card) => !melded.has(card)).sort(byRank);
  return { melds: sortMelds(melds), deadwood, points: points(deadwood) };
}

function sortMelds(melds) {
  return melds
    .map((meld) => meld.slice().sort(isSet(meld) ? (a, b) => suit(a) - suit(b) : byRank))
    .sort((a, b) => byRank(a[0], b[0]));
}

/** The melds that leave the least deadwood: { melds, deadwood, points }. */
export function bestMelds(cards) {
  let best = null;
  for (const melds of meldChoices(cards)) {
    const option = arrangement(cards, melds);
    if (!best || option.points < best.points
      || (option.points === best.points && option.deadwood.length < best.deadwood.length)) best = option;
  }
  return best;
}

// ── A match and its hands ────────────────────────────────────────────────────
/** A new match between player 0 (who starts it) and player 1. */
export function newMatch(target = 100) {
  return {
    target,
    scores: [0, 0],
    wins: [0, 0],
    hands: [],              // a line per finished hand: { kind, winner, points }
    dealer: 1,              // flips before the first deal, so player 0 deals first
    hand: null,
    winner: null,           // who won the match
    final: null,            // the bonus breakdown once someone reaches the target
  };
}

/**
 * Deal a hand from this deck: ten cards each, one at a time, starting with the
 * non-dealer; the next card turns up to start the discard pile; the rest is the stock.
 * The stock is drawn from its end.
 */
export function deal(match, deck) {
  const dealer = 1 - match.dealer;
  const first = 1 - dealer;
  const cards = deck.slice();
  const hands = [[], []];
  for (let k = 0; k < 20; k++) hands[(first + k) % 2].push(cards.shift());
  const upcard = cards.shift();
  match.dealer = dealer;
  match.hand = {
    number: match.hands.length + 1,
    hands,
    pile: [upcard],
    stock: cards.reverse(),     // the next card to draw is at the end
    turn: first,
    phase: 'offer',             // 'offer' → 'draw' → 'discard' → 'draw' … → 'done'
    passes: 0,                  // during the offer: how many have turned down the upcard
    stockOnly: false,           // both passed: the first draw must come from the stock
    took: null,                 // a card just taken from the pile can't go straight back
    last: null,                 // the latest action, for the status line: { who, act, card }
    result: null,
  };
  return match.hand;
}

const handOf = (match) => match.hand;

/** What this player can do now, if anything. */
export function canAct(match, who) {
  const hand = handOf(match);
  return Boolean(hand && match.winner === null && hand.phase !== 'done' && hand.turn === who);
}

/** Pick up the top of the stock or the pile. */
export function take(match, from) {
  const hand = handOf(match);
  const { phase } = hand;
  if (from === 'pile' && !(phase === 'offer' || (phase === 'draw' && !hand.stockOnly))) return false;
  if (from === 'stock' && phase !== 'draw') return false;
  if (from === 'pile' && !hand.pile.length) return false;
  if (from === 'stock' && !hand.stock.length) return false;
  const card = (from === 'pile' ? hand.pile : hand.stock).pop();
  hand.hands[hand.turn].push(card);
  hand.took = from === 'pile' ? card : null;
  hand.stockOnly = false;
  hand.phase = 'discard';
  hand.last = { who: hand.turn, act: from, card: from === 'pile' ? card : null };
  return true;
}

/** Turn down the upcard at the start of a hand. */
export function pass(match) {
  const hand = handOf(match);
  if (hand.phase !== 'offer') return false;
  hand.passes++;
  hand.last = { who: hand.turn, act: 'pass', card: null };
  hand.turn = 1 - hand.turn;
  if (hand.passes === 2) {
    hand.phase = 'draw';
    hand.stockOnly = true;
  }
  return true;
}

/** Which cards the player may discard now. */
export function discardable(match) {
  const hand = handOf(match);
  if (hand?.phase !== 'discard') return [];
  return hand.hands[hand.turn].filter((card) => card !== hand.took);
}

/** The deadwood left after throwing this card: 0 means throwing it is gin. */
export function deadwoodWithout(cards, card) {
  return bestMelds(cards.filter((c) => c !== card)).points;
}

/**
 * Throw a card onto the pile. If the ten cards left all meld, that's gin and the
 * hand ends there; nobody has to claim it.
 */
export function discard(match, card) {
  const hand = handOf(match);
  if (!discardable(match).includes(card)) return false;
  const who = hand.turn;
  const cards = hand.hands[who];
  cards.splice(cards.indexOf(card), 1);
  hand.pile.push(card);
  hand.took = null;
  // Remember what they drew too: a card taken from the pile tells the other player something.
  const drew = hand.last?.who === who && hand.last.act === 'pile' ? hand.last.card : null;
  const gin = bestMelds(cards).points === 0;
  hand.last = { who, act: gin ? 'gin' : 'discard', card, drew };
  if (gin) return finish(match, who), true;
  if (hand.stock.length <= 2) {
    // Only two cards left and nobody has gin: nobody scores.
    hand.phase = 'done';
    hand.result = { kind: 'draw', winner: null, points: 0 };
    match.hands.push({ kind: 'draw', winner: null, points: 0 });
    return true;
  }
  hand.turn = 1 - who;
  hand.phase = 'draw';
  return true;
}

/** Score a hand someone has ginned: 25 plus the loser's deadwood. */
function finish(match, winner) {
  const hand = handOf(match);
  const loser = 1 - winner;
  const theirs = bestMelds(hand.hands[loser]);
  const score = GIN_BONUS + theirs.points;

  hand.phase = 'done';
  hand.result = {
    kind: 'gin', winner, points: score,
    melds: { [winner]: bestMelds(hand.hands[winner]), [loser]: theirs },
  };
  match.scores[winner] += score;
  match.wins[winner]++;
  match.hands.push({ kind: 'gin', winner, points: score });

  if (match.scores[winner] >= match.target) {
    const shutout = match.wins[loser] === 0;
    const base = [0, 1].map((p) => match.scores[p] + BOX_BONUS * match.wins[p] + (p === winner ? GAME_BONUS : 0));
    const totals = base.map((total, p) => (p === winner && shutout ? total * 2 : total));
    match.winner = winner;
    match.final = { shutout, totals, margin: totals[winner] - totals[loser] };
  }
}

/** Cards in the order to show them: melds first (each a group), then the deadwood. */
export function arrange(cards) {
  const { melds, deadwood, points: deadPoints } = bestMelds(cards);
  return { groups: melds, deadwood, points: deadPoints };
}
