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

// Where aces go in a run. Low: A-2-3 only. High: Q-K-A only. Both: either, and a
// run can turn the corner through the ace, as in K-A-2. An ace always counts 1 point.
export const ACES = ['low', 'high', 'both'];
export const acesRule = (aces) => (ACES.includes(aces) ? aces : 'low');

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
// Where a card sorts: an ace goes after the king when aces are high.
const place = (card, aces) => (aces === 'high' && rank(card) === 1 ? 14 : rank(card));
const byRank = (aces = 'low') => (a, b) => place(a, aces) - place(b, aces) || suit(a) - suit(b);
const isSet = (meld) => meld.every((card) => rank(card) === rank(meld[0]));

/** The rank after this one in a run, or null if a run can't go on past it. */
export function nextRank(r, aces = 'low') {
  if (r === 13) return aces === 'low' ? null : 1;
  if (r === 1) return aces === 'high' ? null : 2;
  return r + 1;
}

/** The rank before this one in a run, or null. */
export function prevRank(r, aces = 'low') {
  if (r === 1) return aces === 'low' ? null : 13;
  if (r === 2) return aces === 'high' ? null : 1;
  return r - 1;
}

/** Are these cards one run: three or more of a suit in sequence? */
export function isRun(meld, aces = 'low') {
  if (meld.length < 3 || meld.length > 13 || meld.some((card) => suit(card) !== suit(meld[0]))) return false;
  const ranks = new Set(meld.map(rank));
  if (ranks.size !== meld.length) return false;
  const starts = [...ranks].filter((r) => !ranks.has(prevRank(r, aces)));
  if (starts.length !== 1) return false;
  let length = 1;
  for (let r = nextRank(starts[0], aces); ranks.has(r) && length < ranks.size; r = nextRank(r, aces)) length++;
  return length === ranks.size;
}

/** A run's cards from its low end to its high end. */
function runOrder(meld, aces) {
  const ranks = new Set(meld.map(rank));
  let r = [...ranks].find((x) => !ranks.has(prevRank(x, aces)));
  const out = [];
  for (let k = 0; k < meld.length; k++, r = nextRank(r, aces)) out.push(meld.find((card) => rank(card) === r));
  return out;
}

/** Every set (3 or 4 of a rank) and run (3+ in a row, one suit) these cards can make. */
export function possibleMelds(cards, aces = 'low') {
  const melds = [];
  const ranks = new Map();
  for (const card of cards) ranks.set(rank(card), [...(ranks.get(rank(card)) ?? []), card]);
  for (const group of ranks.values()) {
    if (group.length < 3) continue;
    group.sort(byRank());
    if (group.length === 3) melds.push(group);
    else {
      melds.push(group);
      for (let skip = 0; skip < 4; skip++) melds.push(group.filter((_, k) => k !== skip));
    }
  }
  for (let s = 0; s < 4; s++) {
    const have = new Set(cards.filter((card) => suit(card) === s).map(rank));
    for (let start = 1; start <= 13; start++) {
      const run = [];
      for (let r = start; r !== null && have.has(r) && run.length < 13; r = nextRank(r, aces)) {
        if (run.length && r === start) break;     // all the way round
        run.push(s * 13 + r - 1);
        if (run.length >= 3) melds.push(run.slice());
      }
    }
  }
  return melds;
}

/** Every way to pick non-overlapping melds from these cards (including none). */
function meldChoices(cards, aces) {
  const melds = possibleMelds(cards, aces);
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

function arrangement(cards, melds, aces) {
  const melded = new Set(melds.flat());
  const deadwood = cards.filter((card) => !melded.has(card)).sort(byRank(aces));
  return { melds: sortMelds(melds, aces), deadwood, points: points(deadwood) };
}

function sortMelds(melds, aces) {
  return melds
    .map((meld) => (isSet(meld) ? meld.slice().sort((a, b) => suit(a) - suit(b)) : runOrder(meld, aces)))
    .sort((a, b) => byRank(aces)(a[0], b[0]));
}

/** The melds that leave the least deadwood: { melds, deadwood, points }. */
export function bestMelds(cards, aces = 'low') {
  let best = null;
  for (const melds of meldChoices(cards, aces)) {
    const option = arrangement(cards, melds, aces);
    if (!best || option.points < best.points
      || (option.points === best.points && option.deadwood.length < best.deadwood.length)) best = option;
  }
  return best;
}

// ── A match and its hands ────────────────────────────────────────────────────
/** A new match between player 0 (who starts it) and player 1. */
export function newMatch(target = 100, aces = 'low') {
  return {
    target,
    aces: acesRule(aces),
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

/** Which cards the player may discard now: any of them, even one just taken from the pile. */
export function discardable(match) {
  const hand = handOf(match);
  if (hand?.phase !== 'discard') return [];
  return hand.hands[hand.turn].slice();
}

/** The deadwood left after throwing this card. */
export function deadwoodWithout(cards, card, aces = 'low') {
  return bestMelds(cards.filter((c) => c !== card), aces).points;
}

/**
 * Gin is ten cards in exactly three melds of four, three and three. Other shapes with
 * no deadwood aren't gin: two runs of five, a set and a run of seven, and so on. So two
 * runs of one suit that join end to end (really one longer run) don't count as two melds.
 * Returns the 4-3-3 arrangement, or null.
 */
export function ginMelds(cards, aces = 'low') {
  if (cards.length !== 10) return null;
  const melds = possibleMelds(cards, aces).filter((meld) => meld.length <= 4);
  const walk = (from, used, chosen) => {
    if (chosen.length === 3) {
      const sizes = chosen.map((meld) => meld.length).sort().join('');
      return sizes === '334' && !chosen.some((a) => chosen.some((b) => joins(a, b, aces))) ? chosen : null;
    }
    for (let k = from; k < melds.length; k++) {
      if (melds[k].some((card) => used.has(card))) continue;
      const found = walk(k + 1, new Set([...used, ...melds[k]]), [...chosen, melds[k]]);
      if (found) return found;
    }
    return null;
  };
  const found = walk(0, new Set(), []);
  return found && { melds: sortMelds(found, aces), deadwood: [], points: 0 };
}

/** Do these two runs of one suit make one longer run, end to end? */
function joins(a, b, aces) {
  if (a === b || isSet(a) || isSet(b) || suit(a[0]) !== suit(b[0])) return false;
  return isRun([...a, ...b], aces);
}

/** Would throwing this card leave a 4-3-3 gin? */
export const ginWithout = (cards, card, aces = 'low') => Boolean(ginMelds(cards.filter((c) => c !== card), aces));

/**
 * Throw a card onto the pile. If the ten cards left make a 4-3-3, that's gin and
 * the hand ends there; nobody has to claim it.
 */
export function discard(match, card) {
  const hand = handOf(match);
  if (!discardable(match).includes(card)) return false;
  const who = hand.turn;
  const cards = hand.hands[who];
  cards.splice(cards.indexOf(card), 1);
  hand.pile.push(card);
  // Remember what they drew too: a card taken from the pile tells the other player something.
  const drew = hand.last?.who === who && hand.last.act === 'pile' ? hand.last.card : null;
  const gin = Boolean(ginMelds(cards, acesRule(match.aces)));
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
  const aces = acesRule(match.aces);
  const theirs = bestMelds(hand.hands[loser], aces);
  const score = GIN_BONUS + theirs.points;

  hand.phase = 'done';
  hand.result = {
    kind: 'gin', winner, points: score,
    melds: { [winner]: ginMelds(hand.hands[winner], aces), [loser]: theirs },
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
export function arrange(cards, aces = 'low') {
  const { melds, deadwood, points: deadPoints } = bestMelds(cards, aces);
  return { groups: melds, deadwood, points: deadPoints };
}
