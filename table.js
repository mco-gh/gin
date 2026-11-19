// Draws the card table. Every one of the 52 cards is its own element, placed by
// CSS variables on a 1000-unit-wide grid, so moving a card anywhere (stock to
// hand, hand to pile) is just a change of position and CSS animates the trip.
import { SUITS, rank, suit, rankLabel, cardName, label } from './gin.js';

const W = 1000;
const MODES = {
  wide: { H: 720, CW: 120, CH: 168, spread: 86, gap: 26, backSpread: 44, lift: 34, edge: 26 },
  tall: { H: 1080, CW: 170, CH: 238, spread: 92, gap: 22, backSpread: 50, lift: 44, edge: 34 },
};
const DEAL_STEP = 55;         // ms between cards while dealing

// A small, fixed wobble for each card on the pile so it looks tossed, not stacked.
const wobble = (card, salt) => (((card * 73 + salt * 151) % 97) / 97 - 0.5);

export class Table {
  constructor(root, onCard = null) {
    this.root = root;
    this.onCard = onCard;
    root.classList.add('table-felt');
    root.innerHTML = `
      <div class="spot stock-spot" aria-hidden="true"></div>
      <div class="spot pile-spot" aria-hidden="true"><span>Discard</span></div>
      <div class="cards"></div>`;
    this.layer = root.querySelector('.cards');
    this.cards = new Map();
    for (let card = 0; card < 52; card++) {
      const el = document.createElement('div');
      el.className = `card s${suit(card)}`;
      el.innerHTML = '<div class="card-in"><div class="face"></div><div class="back"></div></div>';
      el.dataset.card = card;
      el.style.setProperty('--x', 440);
      el.style.setProperty('--y', 276);
      this.layer.append(el);
      this.cards.set(card, el);
    }
    this.mode = 'wide';
    this.lastScene = null;
    this.handNo = null;

    if (onCard) {
      root.addEventListener('click', (event) => {
        const el = event.target.closest('.card.can');
        if (el) onCard(Number(el.dataset.card), event.detail);
      });
      root.addEventListener('keydown', (event) => {
        const el = event.target.closest?.('.card.can');
        if (!el || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onCard(Number(el.dataset.card), 1);
      });
    }
    new ResizeObserver(() => this.fit()).observe(root.parentElement);
    this.fit();
  }

  fit() {
    const width = this.root.parentElement.clientWidth;
    const mode = width && width < 560 ? 'tall' : 'wide';
    if (mode === this.mode && this.root.dataset.mode) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.root.closest('.table-wrap')?.setAttribute('data-mode', mode);
    if (this.lastScene) this.draw(this.lastScene, { instant: true });
  }

  get m() { return MODES[this.mode]; }

  /**
   * Lay out a hand. `view`:
   *   hand        the current hand (from gin.js)
   *   me          which player sits at the bottom
   *   mine        { groups, deadwood } — my cards, already arranged into melds
   *   selected    my card picked up to discard, or null
   *   canDraw     { stock, pile } — which piles can be clicked
   *   canThrow    cards I may click in my hand
   *   result      the hand's result once it is over: both hands are laid out face up
   */
  show(view) {
    const dealing = view.hand && view.hand.number !== this.handNo;
    this.handNo = view.hand?.number ?? null;
    this.draw(view, { dealing });
  }

  draw(view, { instant = false, dealing = false } = {}) {
    this.lastScene = view;
    const { hand, me } = view;
    const m = this.m;
    // On the wrapper, so things laid over the table (like the stock count) can line up with it.
    const wrap = this.root.parentElement;
    wrap.style.setProperty('--h', m.H);
    wrap.style.setProperty('--cw', m.CW);
    wrap.style.setProperty('--ch', m.CH);

    const place = new Map();       // card → { x, y, r, z, up, cls, can, label }
    const centerY = this.mode === 'tall' ? (m.H - m.CH) / 2 - 20 : (m.H - m.CH) / 2;
    const stockX = W / 2 - m.CW - 36;
    const pileX = W / 2 + 36;
    wrap.style.setProperty('--stock-x', stockX);
    wrap.style.setProperty('--pile-x', pileX);
    wrap.style.setProperty('--center-y', centerY);

    if (!hand) {
      for (const card of this.cards.keys()) place.set(card, { x: stockX, y: centerY, r: 0, z: card, up: false });
      return this.apply(place, { instant: true });
    }

    // The stock: a neat, slightly thick pile of backs.
    hand.stock.forEach((card, k) => {
      const lift = Math.floor(k / 4);
      const top = k === hand.stock.length - 1;
      place.set(card, {
        x: stockX - lift * 0.8, y: centerY - lift * 1.1, r: 0, z: 1 + k, up: false,
        can: top && view.canDraw?.stock, cls: top && view.canDraw?.stock ? 'grab' : '', label: top ? `Stock, ${hand.stock.length} cards. Draw one.` : null,
      });
    });

    // The pile: face up, each card a little askew.
    hand.pile.forEach((card, k) => {
      const top = k === hand.pile.length - 1;
      place.set(card, {
        x: pileX + wobble(card, 1) * 14, y: centerY + wobble(card, 2) * 12, r: wobble(card, 3) * 12,
        z: 100 + k, up: true, can: top && view.canDraw?.pile, cls: top && view.canDraw?.pile ? 'grab' : '',
        label: top ? `Discard pile, ${cardName(card)}${view.canDraw?.pile ? '. Take it.' : ''}` : null,
      });
    });

    const them = 1 - me;
    if (view.result && view.result.melds) {
      // The hand is over: both hands face up, in their melds.
      this.layoutReveal(place, view.result, me, them);
    } else {
      // Mine, along the bottom in a gentle fan, melds grouped together.
      const groups = [...view.mine.groups.map((g, k) => g.map((card) => ({ card, cls: `meld g${k % 4}` }))),
        view.mine.deadwood.map((card) => ({ card, cls: '' }))].filter((g) => g.length);
      const row = this.row(groups, m.H - m.CH - m.edge, m.spread, m.gap, 1);
      for (const spot of row) {
        const mine = spot.card === view.selected;
        const can = view.canThrow?.includes(spot.card);
        place.set(spot.card, {
          ...spot, z: 300 + spot.i, up: true,
          y: spot.y - (mine ? m.lift : 0),
          cls: `${spot.cls}${mine ? ' sel' : ''}`,
          can, label: `${cardName(spot.card)}${mine ? ', picked up' : ''}`,
        });
      }

      // Theirs, face down along the top, fanned the other way.
      const theirs = hand.hands[them].map((card) => ({ card, cls: '' }));
      const half = (theirs.length - 1) / 2;
      const fan = this.row([theirs], m.edge * 0.6 + half * half * (this.mode === 'tall' ? 1.2 : 0.9), m.backSpread, 0, -1);
      for (const spot of fan) place.set(spot.card, { ...spot, z: 200 + spot.i, up: false });
    }

    // Dealing: start every card on the stock, then send them out one by one.
    if (dealing && !instant && hand.phase === 'offer' && hand.pile.length === 1) {
      // The non-dealer (whose turn it is) gets the first card, then they alternate.
      const delays = new Map();
      for (let k = 0; k < 10; k++) {
        delays.set(hand.hands[hand.turn][k], 2 * k * DEAL_STEP);
        delays.set(hand.hands[1 - hand.turn][k], (2 * k + 1) * DEAL_STEP);
      }
      delays.set(hand.pile[0], 21 * DEAL_STEP);
      // Gather last hand's cards into the stock, then deal.
      const gather = new Map();
      for (const card of this.cards.keys()) {
        const order = delays.has(card) ? 60 - delays.get(card) / DEAL_STEP : hand.stock.indexOf(card);
        gather.set(card, { x: stockX, y: centerY, r: 0, z: 400 + order, up: false });
      }
      const gathered = [...this.cards.values()].some((el) => el.style.getPropertyValue('--x') !== String(stockX.toFixed(1)));
      this.apply(gather);
      clearTimeout(this.dealTimer);
      this.dealTimer = setTimeout(() => {
        if (this.lastScene === view) this.apply(place, { delays });
      }, gathered ? 520 : 30);
      return;
    }
    this.apply(place, { instant });
  }

  /** Cards in one or more groups across a row, centred, fanned by `arc` (1 down, -1 up, 0 flat). */
  row(groups, y, spread, gap, arc) {
    const m = this.m;
    const n = groups.reduce((sum, g) => sum + g.length, 0);
    if (!n) return [];
    const gaps = groups.length - 1;
    const room = W - 2 * 20 - m.CW - gaps * gap;
    const step = n > 1 ? Math.min(spread, room / (n - 1)) : 0;
    const width = step * (n - 1) + gaps * gap + m.CW;
    let x = (W - width) / 2;
    const out = [];
    let i = 0;
    const mid = (n - 1) / 2;
    groups.forEach((group, g) => {
      if (g) x += gap;
      for (const item of group) {
        const off = i - mid;
        out.push({
          card: item.card, cls: item.cls, i,
          x, y: y + arc * off * off * (this.mode === 'tall' ? 1.2 : 0.9),
          r: arc * off * (this.mode === 'tall' ? 1.4 : 1.6),
        });
        x += step;
        i++;
      }
    });
    return out;
  }

  layoutReveal(place, result, me, them) {
    const m = this.m;
    const rows = { [them]: m.edge, [me]: m.H - m.CH - m.edge };
    for (const who of [me, them]) {
      const arr = result.melds[who];
      const groups = arr.melds.map((meld, k) => meld.map((card) => ({ card, cls: `meld g${k % 4}` })));
      groups.push(arr.deadwood.map((card) => ({ card, cls: 'dead' })));
      const spots = this.row(groups.filter((g) => g.length), rows[who], m.spread, m.gap, 0);
      for (const spot of spots) {
        place.set(spot.card, { ...spot, z: (who === me ? 300 : 200) + spot.i, up: true, label: cardName(spot.card) });
      }
    }
  }

  apply(place, { instant = false, delays = null } = {}) {
    for (const [card, el] of this.cards) {
      const spot = place.get(card);
      if (!spot) { el.hidden = true; continue; }
      el.hidden = false;
      // Anything still pending from an earlier layout (a deal, a flip) is out of date now.
      for (const timer of el.timers ?? []) clearTimeout(timer);
      el.timers = [];
      const later = (fn, ms) => el.timers.push(setTimeout(fn, ms));
      const delay = delays?.get(card) ?? 0;
      el.style.transitionDelay = delays ? `${delay}ms` : '';
      el.style.setProperty('--x', spot.x.toFixed(1));
      el.style.setProperty('--y', spot.y.toFixed(1));
      el.style.setProperty('--r', `${(spot.r ?? 0).toFixed(2)}deg`);
      if (delays) later(() => { el.style.zIndex = String(spot.z); }, delay);
      else el.style.zIndex = String(spot.z);
      const wasUp = el.classList.contains('up');
      el.className = `card s${suit(card)}${spot.cls ? ` ${spot.cls}` : ''}${spot.can ? ' can' : ''}${instant ? ' still' : ''}`;
      if (spot.up) {
        this.paint(el, card);
        if (delays) later(() => el.classList.add('up'), delay + 160);   // turn over on arrival
        else el.classList.add('up');
      } else if (el.dataset.painted) {
        // Keep the face out of the page once it has turned away.
        later(() => this.unpaint(el), wasUp ? 500 : 0);
      }
      if (spot.can) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
      } else {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
      }
      if (spot.label) el.setAttribute('aria-label', spot.label);
      else if (spot.up) el.setAttribute('aria-label', cardName(card));
      else el.removeAttribute('aria-label');
      el.setAttribute('aria-hidden', String(!spot.label && !spot.up));
    }
    if (instant) {
      void this.root.offsetWidth;
      requestAnimationFrame(() => { for (const el of this.cards.values()) el.classList.remove('still'); });
    } else if (delays) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const el of this.cards.values()) el.classList.remove('still');
      }));
    }
  }

  paint(el, card) {
    if (el.dataset.painted === '1') return;
    el.dataset.painted = '1';
    el.querySelector('.face').innerHTML = faceHTML(card);
  }

  unpaint(el) {
    delete el.dataset.painted;
    el.querySelector('.face').replaceChildren();
  }
}

export function faceHTML(card) {
  const r = rankLabel(card);
  const s = SUITS[suit(card)];
  const court = rank(card) > 10;
  const center = court
    ? `<span class="court"><b>${r}</b><i>${s}</i></span>`
    : rank(card) === 1 ? `<span class="pip ace">${s}</span>` : `<span class="pip">${s}</span>`;
  return `<span class="idx"><b>${r}</b><i>${s}</i></span>${center}<span class="idx flip"><b>${r}</b><i>${s}</i></span>`;
}

/** A static fan of face-up cards, for the lobby. */
export function fan(root, cards, groups = []) {
  root.classList.add('fan');
  const mid = (cards.length - 1) / 2;
  cards.forEach((card, k) => {
    const el = document.createElement('div');
    const g = groups.findIndex((group) => group.includes(card));
    el.className = `card up s${suit(card)}${g >= 0 ? ` meld g${g}` : ''}`;
    el.innerHTML = `<div class="card-in"><div class="face">${faceHTML(card)}</div><div class="back"></div></div>`;
    el.style.setProperty('--i', k - mid);
    el.setAttribute('aria-hidden', 'true');
    el.title = label(card);
    root.append(el);
  });
}
