// Gin: the page logic. gin.js knows the rules, table.js draws, net.js connects;
// this file runs the lobby, the turn-by-turn flow, chat, video and settings.
//
// Both browsers keep the same copy of the match. The host shuffles and deals
// (sending the whole match), and each player's actions are sent to the other,
// who checks them against their own copy and applies them.
import * as Gin from './gin.js';
import { Table, fan } from './table.js';
import { openLink, newCode, cleanCode } from './net.js';
import { openBot, LEVELS as BOT_LEVELS } from './bot.js';

const $ = (id) => document.getElementById(id);

// ── Colors ───────────────────────────────────────────────────────────────────
const THEMES = {
  Carnival: { felt: '#2a1f5c', rail: '#6c4cf1', backA: '#ee4266', backB: '#ffd23f' },
  Classic: { felt: '#1e6f50', rail: '#5b3a1e', backA: '#8c1c13', backB: '#f2d9a6' },
  Ocean: { felt: '#0b3954', rail: '#087e8b', backA: '#1a659e', backB: '#4ecdc4' },
  Sunset: { felt: '#e36414', rail: '#5f0f40', backA: '#0f4c5c', backB: '#ffb347' },
  Sorbet: { felt: '#7cc6c9', rail: '#457b9d', backA: '#ff5d8f', backB: '#ffd166' },
};
const CSS_VAR = { felt: '--felt', rail: '--rail', backA: '--back-a', backB: '--back-b' };

function loadColors() {
  try {
    const saved = JSON.parse(localStorage.getItem('gin-colors'));
    const ok = saved && Object.keys(CSS_VAR).every((k) => /^#[0-9a-f]{6}$/i.test(saved[k]));
    if (ok) return saved;
  } catch {}
  return { ...THEMES.Carnival };
}

let colors = loadColors();

function applyColors(save = false) {
  for (const [key, name] of Object.entries(CSS_VAR)) document.documentElement.style.setProperty(name, colors[key]);
  for (const input of document.querySelectorAll('[data-color]')) input.value = colors[input.dataset.color];
  for (const button of $('theme-list').children) {
    const theme = THEMES[button.dataset.theme];
    button.setAttribute('aria-pressed', String(Object.keys(CSS_VAR).every((k) => theme[k] === colors[k])));
  }
  if (save) try { localStorage.setItem('gin-colors', JSON.stringify(colors)); } catch {}
}

for (const [name, theme] of Object.entries(THEMES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme';
  button.dataset.theme = name;
  for (const [key, cssVar] of Object.entries(CSS_VAR)) button.style.setProperty(cssVar, theme[key]);
  const swatch = document.createElement('span');
  swatch.className = 'theme-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  swatch.append(document.createElement('i'));
  button.append(swatch, name);
  button.addEventListener('click', () => { colors = { ...theme }; applyColors(true); });
  $('theme-list').append(button);
}
for (const input of document.querySelectorAll('[data-color]')) {
  input.addEventListener('input', () => { colors[input.dataset.color] = input.value; applyColors(true); });
}
applyColors();

function applySuits(save = false) {
  const four = $('four-color').checked;
  document.documentElement.classList.toggle('two-color', !four);
  if (save) try { localStorage.setItem('gin-four-color', four ? '1' : '0'); } catch {}
}
try { $('four-color').checked = localStorage.getItem('gin-four-color') !== '0'; } catch {}
$('four-color').addEventListener('change', () => applySuits(true));
applySuits();

// ── State ────────────────────────────────────────────────────────────────────
let link = null;          // the connection (or the computer), or null
let vsBot = null;         // the computer's level when playing it, else null
let host = false;
let code = '';
let target = 100;         // what the host chose in the lobby
let me = 0;               // the host is player 0, their guest player 1
let match = null;
let selected = null;      // my card picked up, ready to throw
let peerHere = false;
let ready = [false, false];  // both want the next hand (or a new game)
let celebrated = '';

// Sorting my hand: automatically into melds (the default) or by hand. Only this
// browser knows the order; the other player never sees it.
let sortMode = 'auto';
try { if (localStorage.getItem('gin-sort') === 'manual') sortMode = 'manual'; } catch {}
let myOrder = [];         // manual order of my cards
let orderHand = null;     // which hand myOrder belongs to

const table = new Table($('table'), onCard, (order) => { myOrder = order; render(); });

for (const input of document.querySelectorAll('input[name="sort"]')) {
  input.checked = input.value === sortMode;
  input.addEventListener('change', () => {
    if (!input.checked) return;
    // Switching to manual starts from the order on screen, so nothing jumps.
    if (input.value === 'manual' && hand()) myOrder = autoOrder(hand().hands[me]);
    sortMode = input.value;
    try { localStorage.setItem('gin-sort', sortMode); } catch {}
    render();
  });
}

// Where aces go in runs: chosen when starting a game (Both by default) and stored in
// the match, so both browsers, and the computer, play by the starter's choice.
let acesPick = 'both';
try { acesPick = Gin.acesRule(localStorage.getItem('gin-aces-start') ?? 'both'); } catch {}
for (const input of document.querySelectorAll('input[name="aces"]')) {
  input.checked = input.value === acesPick;
  input.addEventListener('change', () => {
    acesPick = Gin.acesRule(input.value);
    try { localStorage.setItem('gin-aces-start', acesPick); } catch {}
  });
}
const aces = () => Gin.acesRule(match?.aces);

/** My cards as auto-sort shows them: melds first, then deadwood. */
function autoOrder(cards) {
  const { groups, deadwood } = Gin.arrange(cards, aces());
  return [...groups.flat(), ...deadwood];
}

/** My cards in my own order: cards that left are dropped, new ones join at the right. */
function manualOrder(h) {
  const cards = h.hands[me];
  if (orderHand !== h.number) {
    orderHand = h.number;
    myOrder = autoOrder(cards);           // each new hand starts sorted
  }
  myOrder = myOrder.filter((card) => cards.includes(card));
  for (const card of cards) if (!myOrder.includes(card)) myOrder.push(card);
  return myOrder;
}

// The lobby's sample hand: two melds and a little deadwood.
const S = (r, s) => s * 13 + r - 1;
const sample = [S(7, 0), S(7, 1), S(7, 3), S(4, 2), S(5, 2), S(6, 2), S(12, 1), S(13, 0)];
fan($('preview'), sample, [[S(7, 0), S(7, 1), S(7, 3)], [S(4, 2), S(5, 2), S(6, 2)]]);

// ── Toast ────────────────────────────────────────────────────────────────────
const toastEl = $('toast');
const nativePopover = 'showPopover' in toastEl;
if (!nativePopover) toastEl.removeAttribute('popover');
let toastTimer = 0;
function toast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  if (nativePopover) {
    if (toastEl.matches(':popover-open')) toastEl.hidePopover();
    toastEl.showPopover();                       // re-showing lifts it above any open dialog
  } else {
    toastEl.classList.add('show');
  }
  toastTimer = setTimeout(() => {
    if (nativePopover) toastEl.hidePopover();
    else toastEl.classList.remove('show');
  }, 3800);
}

// ── Lobby ────────────────────────────────────────────────────────────────────
function setLobby(state, error = '') {
  $('setup').hidden = state !== 'idle';
  $('invite').hidden = state !== 'waiting';
  $('joining').hidden = state !== 'joining' && state !== 'opening';
  $('joining').lastChild.textContent = state === 'opening' ? 'Setting up your game…' : 'Joining the game…';
  $('lobby-error').hidden = !error;
  $('lobby-error').textContent = error;
  if (state === 'waiting') $('code-text').textContent = code;
}

function show(screen) {
  $('lobby').hidden = screen !== 'lobby';
  $('game').hidden = screen !== 'game';
  document.body.dataset.vs = vsBot ? 'bot' : 'friend';
  $('them-name').textContent = vsBot ? 'Computer' : 'Opponent';
}

const inviteLink = () => `${location.origin}${location.pathname}#${code}`;

const PROBLEMS = {
  noroom: 'No game found with that code. Check it and try again.',
  full: 'That game already has two players.',
  network: 'Couldn’t reach the connection service. Check your internet and try again.',
  browser: 'This browser can’t make peer-to-peer connections.',
  lost: 'The connection dropped before the game started.',
  left: 'The other player left.',
  unreachable: 'Couldn’t connect to the other player. Try again, or try a different network or browser.',
};

function connect() {
  if (!match) setLobby(host ? 'opening' : 'joining');
  // Ignore callbacks from a connection we have already replaced or dropped.
  const guard = (fn) => (...args) => { if (link === mine) fn(...args); };
  const mine = (vsBot ? openBot : openLink)({
    code,
    host,
    level: vsBot,
    on: {
      waiting: guard(() => { if (!match) setLobby('waiting'); }),
      open: guard(onPeer),
      message: guard(onMessage),
      peerLeft: guard(onPeerLeft),
      remoteStream: guard(showRemote),
      ended: guard(onEnded),
    },
  });
  link = mine;
  if (localStream) link.setMedia(localStream);
}

function onPeer() {
  peerHere = true;
  if ($('lost').open) $('lost').close();
  if (!host) return;                    // the host's first message tells a guest what to show
  if (match) {
    sendSync();
    toast('Your opponent is back.');
    render();
  } else {
    startMatch();
  }
}

function onPeerLeft() {
  peerHere = false;
  toast('Your opponent disconnected.');
  render();
}

function onEnded(reason) {
  link = null;
  peerHere = false;
  if (reason === 'taken' && host && !match) {
    code = newCode();                   // someone else has that code; quietly pick another
    return connect();
  }
  if (!match) return toLobby(PROBLEMS[reason] ?? PROBLEMS.network);
  if (reason === 'left') {
    toast('Your opponent left the game.');
    return toLobby();
  }
  $('lost-text').textContent = host
    ? 'The connection service dropped. Rejoin to keep this game open for your opponent.'
    : reason === 'noroom'
      ? 'Couldn’t find the game. Your opponent may have left.'
      : 'The link to your opponent dropped. The game is still there if they are.';
  render();
  if (!$('lost').open) $('lost').showModal();
}

function toLobby(error = '') {
  link?.close();
  link = null;
  match = null;
  peerHere = false;
  stopMedia();
  showRemote(null);
  $('chat-log').replaceChildren();
  $('chat-empty').hidden = false;
  for (const id of ['lost', 'leave']) if ($(id).open) $(id).close();
  if (location.hash) history.replaceState(null, '', location.pathname);
  show('lobby');
  setLobby('idle', error);
}

$('start-form').addEventListener('submit', (event) => {
  event.preventDefault();
  host = true;
  me = 0;
  const form = new FormData(event.target);
  target = Number(form.get('target')) || 100;
  vsBot = event.submitter?.value === 'bot' ? (BOT_LEVELS[form.get('bot')] ? form.get('bot') : 'medium') : null;
  if (vsBot) try { localStorage.setItem('gin-bot', vsBot); } catch {}
  code = vsBot ? 'computer' : newCode();
  connect();
});

try {
  const saved = localStorage.getItem('gin-bot');
  const input = document.querySelector(`input[name="bot"][value="${saved}"]`);
  if (input) input.checked = true;
} catch {}

function join(text) {
  const wanted = cleanCode(text);
  if (wanted.length !== 7) return setLobby('idle', 'A game code looks like abc-def.');
  host = false;
  vsBot = null;
  me = 1;
  code = wanted;
  history.replaceState(null, '', `#${code}`);
  connect();
}

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  join($('join-code').value);
});

$('cancel-wait').addEventListener('click', () => toLobby());
$('leave-yes').addEventListener('click', () => toLobby());
$('lost-quit').addEventListener('click', () => toLobby());
$('lost-rejoin').addEventListener('click', () => {
  $('lost').close();
  connect();
});
$('lost').addEventListener('cancel', (event) => event.preventDefault());

if (navigator.share) {
  $('share-btn').hidden = false;
  $('share-btn').addEventListener('click', () => {
    navigator.share({ title: 'Gin', text: 'Play gin rummy with me!', url: inviteLink() }).catch(() => {});
  });
}

// Tell the other player when this tab goes away for good.
addEventListener('pagehide', (event) => { if (!event.persisted) link?.close(); });

// ── The game ─────────────────────────────────────────────────────────────────
const send = (message) => link?.send(message);
const sendSync = () => send({ t: 'sync', match, ready });

function startMatch() {
  match = Gin.newMatch(Gin.TARGETS.includes(target) ? target : 100, acesPick);
  dealNext();
}

/** Host only: shuffle, deal and send the new hand to the guest. */
function dealNext() {
  Gin.deal(match, Gin.shuffledDeck());
  ready = [false, false];
  selected = null;
  sendSync();
  begin();
}

function begin() {
  show('game');
  render();
}

const them = () => 1 - me;
const hand = () => match?.hand;

// When I last drew. A double-click on a pile is two clicks, and the second would land on
// the card that just arrived in my hand, so ignore clicks on my hand for a moment.
let drewAt = 0;
const SETTLE_MS = 450;

function onCard(card) {
  const h = hand();
  if (!h || !Gin.canAct(match, me)) return;
  if (h.phase === 'draw') {
    const from = card === h.stock.at(-1) ? 'stock' : card === h.pile.at(-1) ? 'pile' : null;
    if (from) {
      drewAt = performance.now();
      act({ act: 'take', from });
    }
    return;
  }
  if (h.phase !== 'discard' || !Gin.discardable(match).includes(card)) return;
  if (performance.now() - drewAt < SETTLE_MS) return;
  // Discarding always takes two separate taps (pick up, then throw), never a double-click.
  if (selected === card) return act({ act: 'discard', card });
  selected = card;
  render();
}

/** Do something on my turn, and tell the other browser. */
function act(action) {
  if (!apply(match, me, action)) return;
  send({ t: 'act', ...action });
  selected = null;
  render();
}

/** Apply an action by player `who`, if it's legal. */
function apply(m, who, action) {
  if (!m || !Gin.canAct(m, who)) return false;
  switch (action.act) {
    case 'take': return (action.from === 'stock' || action.from === 'pile') && Gin.take(m, action.from);
    case 'discard': return Gin.isCard(action.card) && Gin.discard(m, action.card);
    default: return false;
  }
}

$('throw').addEventListener('click', () => { if (selected !== null) act({ act: 'discard', card: selected }); });

$('next').addEventListener('click', () => {
  if (hand()?.phase !== 'done') return;
  if (!peerHere) return toast('Your opponent isn’t connected.');
  ready[me] = true;
  send({ t: 'ready', over: match.winner !== null });
  maybeDeal();
  render();
});

function maybeDeal() {
  if (!host || !ready[0] || !ready[1]) return;
  if (match.winner !== null) startMatch();
  else dealNext();
}

// What the other player just did, in words.
function lastMove() {
  const h = hand();
  const last = h?.last;
  if (!last || last.who === me) return '';
  const card = last.card === null ? '' : Gin.label(last.card);
  const drew = last.drew === null || last.drew === undefined ? null : Gin.label(last.drew);
  if (drew && last.act === 'discard') {
    return last.drew === last.card
      ? `They took the ${drew} from the pile and threw it back.`
      : `They took the ${drew} from the pile and threw the ${card}.`;
  }
  return {
    pile: `They took the ${card} from the pile.`,
    stock: 'They drew from the stock.',
    discard: `They threw the ${card}.`,
    gin: `They threw the ${card} and went gin!`,
  }[last.act] ?? '';
}

function render() {
  const h = hand();
  if (!match || !h) return;
  const myTurn = Gin.canAct(match, me);
  const { phase } = h;
  const mine = Gin.arrange(h.hands[me], aces());
  const canThrow = myTurn && phase === 'discard' ? Gin.discardable(match) : [];
  if (!canThrow.includes(selected)) selected = null;
  const canDraw = {
    stock: myTurn && phase === 'draw',
    pile: myTurn && phase === 'draw',
  };

  let order = null;
  if (sortMode === 'manual') {
    // Keep the meld colors, so you can still see what melds you have.
    const color = new Map(mine.groups.flatMap((g, k) => g.map((card) => [card, `meld g${k % 4}`])));
    order = manualOrder(h).map((card) => ({ card, cls: color.get(card) ?? '' }));
  }
  table.show({
    hand: h, me, mine, order, manual: sortMode === 'manual', selected, canDraw, canThrow,
    result: phase === 'done' ? h.result : null,
  });
  $('sort-pick').hidden = phase === 'done';

  // Seats
  $('seat-me').classList.toggle('turn', myTurn);
  $('seat-them').classList.toggle('turn', phase !== 'done' && h.turn === them());
  $('score-me').textContent = `${match.scores[me]} pts`;
  $('score-them').textContent = `${match.scores[them()]} pts`;

  // Deadwood, and what the selected card would leave
  let after = null;
  if (selected !== null) after = Gin.deadwoodWithout(h.hands[me], selected, aces());
  // Throwing any of these would leave every card in a meld: gin, claimed the moment it's thrown.
  const ginCards = canThrow.filter((card) => Gin.ginWithout(h.hands[me], card, aces()));
  const ginIfThrown = selected !== null && ginCards.includes(selected);
  $('deadwood').textContent = phase === 'done' ? ''
    : after !== null ? `Deadwood after: ${after}` : `Deadwood: ${mine.points}`;
  $('deadwood').dataset.level = ginIfThrown || (selected === null && ginCards.length) ? 'low' : '';

  $('throw').hidden = selected === null;

  // Status
  let status = '';
  const theirs = lastMove();
  const pileTop = h.pile.length ? Gin.label(h.pile.at(-1)) : '';
  if (phase === 'done') {
    status = match.winner !== null ? 'Game over.' : `Hand ${h.number} is over.`;
  } else if (!myTurn) {
    status = `${theirs} Their turn…`.trim();
  } else if (phase === 'draw') {
    status = `${theirs} Draw from the stock, or take the ${pileTop}.`.trim();
  } else if (selected !== null) {
    status = ginIfThrown ? 'Throw it and go gin!'
      : after === 0 ? 'No deadwood, but gin has to be a 4-3-3. Tap it again to throw it.'
      : 'Tap it again to throw it.';
  } else {
    status = ginCards.length ? 'You have gin! Throw your spare card.' : 'Pick a card to throw.';
  }
  $('status').textContent = status;

  const stockNote = $('pile-note');
  stockNote.textContent = phase === 'done' ? '' : `${h.stock.length} left`;

  // Link
  const linkState = $('link-state');
  linkState.dataset.state = peerHere ? 'on' : 'off';
  $('link-text').textContent = vsBot ? `🤖 ${BOT_LEVELS[vsBot].name}` : peerHere ? 'Connected' : host ? `Away. They can rejoin with ${code}` : 'Disconnected';

  renderScores();
  renderResult();
}

function renderScores() {
  const acesNote = { low: ' · aces low', high: ' · aces high', both: ' · aces high or low' }[aces()];
  $('target-note').textContent = `· first to ${match.target}${acesNote}`;
  for (const [who, key] of [[me, 'me'], [them(), 'them']]) {
    $(`total-${key}`).textContent = match.scores[who];
    $(`bar-${key}`).style.inlineSize = `${Math.min(100, (match.scores[who] / match.target) * 100)}%`;
  }
  const log = $('hand-log');
  log.replaceChildren(...match.hands.map((line, k) => {
    const item = document.createElement('li');
    const who = line.winner === null ? '' : line.winner === me ? 'You' : 'Them';
    item.className = line.winner === null ? 'draw' : line.winner === me ? 'me' : 'them';
    item.innerHTML = `<span>Hand ${k + 1}</span><span></span><b></b>`;
    item.children[1].textContent = line.winner === null ? 'Draw' : `${who}, gin`;
    item.children[2].textContent = line.winner === null ? '–' : `+${line.points}`;
    return item;
  }));
  log.scrollTop = log.scrollHeight;
}

function renderResult() {
  const h = hand();
  const panel = $('result');
  if (h.phase !== 'done') {
    panel.hidden = true;
    celebrated = '';
    return;
  }
  const r = h.result;
  panel.hidden = false;
  const iWon = r.winner === me;
  let title;
  let sub;
  if (r.kind === 'draw') {
    title = 'It’s a draw';
    sub = 'The stock ran low and nobody went gin. No points this hand.';
  } else {
    title = iWon ? 'Gin! 🎉' : 'They went gin';
    sub = iWon
      ? `You score ${r.points}: 25 for gin plus their deadwood.`
      : `They score ${r.points}: 25 for gin plus your deadwood.`;
  }

  const lines = [];
  if (r.melds) {
    lines.push(['Your deadwood', String(r.melds[me].points)]);
    lines.push(['Their deadwood', String(r.melds[them()].points)]);
  }

  if (match.winner !== null) {
    lines.length = 0;                   // the game's totals matter more than this hand's now
    const f = match.final;
    const wonGame = match.winner === me;
    title = wonGame ? 'You win the game! 🏆' : 'They win the game';
    sub = `${title.startsWith('You') ? 'Brilliant.' : 'Good game.'} Final score ${f.totals[me]} to ${f.totals[them()]}.`;
    lines.push(['Points', `${match.scores[me]} – ${match.scores[them()]}`]);
    lines.push([`Hands won (×${Gin.BOX_BONUS})`, `${match.wins[me] * Gin.BOX_BONUS} – ${match.wins[them()] * Gin.BOX_BONUS}`]);
    lines.push(['Game bonus', wonGame ? `${Gin.GAME_BONUS} – 0` : `0 – ${Gin.GAME_BONUS}`]);
    if (f.shutout) lines.push(['Shutout!', 'winner doubled']);
  }

  $('result-title').textContent = title;
  $('result-sub').textContent = sub;
  $('result-lines').replaceChildren(...lines.flatMap(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));
  const over = match.winner !== null;
  $('next').textContent = ready[me] ? (ready[them()] ? 'Dealing…' : 'Waiting for them…') : over ? 'Play again' : 'Next hand';
  $('next').disabled = ready[me];
  $('result').dataset.mood = r.kind === 'draw' ? 'draw' : iWon ? 'win' : 'lose';
  if (ready[them()] && !ready[me]) $('result-sub').textContent += over ? ' They’d like a rematch.' : ' They’re ready for the next hand.';

  const key = `${h.number}:${over}`;
  if (celebrated === key) return;
  celebrated = key;
  const confetti = $('confetti');
  confetti.replaceChildren();
  if (!(over ? match.winner === me : iWon && r.kind === 'gin')) return;
  const shades = [colors.backA, colors.backB, '#ffc83d', '#19c3a3', '#3db8ff', '#ffffff'];
  for (let n = 0; n < (over ? 70 : 44); n++) {
    const bit = document.createElement('i');
    bit.style.setProperty('--left', `${Math.random() * 100}%`);
    bit.style.setProperty('--delay', `${Math.random() * 0.9}s`);
    bit.style.setProperty('--spin', `${(Math.random() - 0.5) * 900}deg`);
    bit.style.background = shades[n % shades.length];
    confetti.append(bit);
  }
}

// ── Messages from the other player ───────────────────────────────────────────
function validMatch(m) {
  const h = m?.hand;
  if (!h || !Array.isArray(m.scores) || !Array.isArray(h.hands) || h.hands.length !== 2) return false;
  const all = [...h.hands[0], ...h.hands[1], ...h.pile, ...h.stock];
  return all.length === 52 && new Set(all).size === 52 && all.every(Gin.isCard);
}

function onMessage(message) {
  switch (message?.t) {
    case 'sync':
      if (host || !validMatch(message.match)) return;
      match = message.match;
      ready = Array.isArray(message.ready) ? message.ready.map(Boolean) : [false, false];
      selected = null;
      return begin();
    case 'resync':
      return host && match ? sendSync() : undefined;
    case 'ready':
      if (hand()?.phase !== 'done') return;
      ready[them()] = true;
      maybeDeal();
      return render();
    case 'chat':
      return addChat('them', String(message.text ?? '').slice(0, 500));
    case 'act':
      if (!apply(match, them(), message)) return host ? sendSync() : send({ t: 'resync' });
      return render();
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
let chatVisible = true;
new IntersectionObserver(([entry]) => { chatVisible = entry.isIntersecting; }).observe($('chat-log'));

function addChat(who, text) {
  if (!text.trim()) return;
  const log = $('chat-log');
  const item = document.createElement('li');
  item.className = who;
  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = who === 'me' ? 'You: ' : 'Opponent: ';
  item.append(label, text);
  log.append(item);
  log.scrollTop = log.scrollHeight;
  $('chat-empty').hidden = true;
  if (who === 'them' && !chatVisible) toast(`💬 ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
}

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!link?.connected) return toast('Your opponent isn’t connected right now.');
  send({ t: 'chat', text });
  addChat('me', text);
  input.value = '';
});

// ── Camera and microphone ────────────────────────────────────────────────────
const want = { cam: false, mic: false };
let localStream = null;
let mediaJob = Promise.resolve();

async function syncMedia() {
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  if (want.cam || want.mic) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: want.cam ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
        audio: want.mic,
      });
    } catch {
      want.cam = want.mic = false;
      toast('Couldn’t use your camera or microphone. Check this site’s permissions.');
    }
  }
  if (!match && localStream) {          // left the game while the browser was asking
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    want.cam = want.mic = false;
  }
  $('video-me').srcObject = want.cam ? localStream : null;
  $('videos').dataset.me = want.cam ? 'cam' : want.mic ? 'mic' : 'off';
  $('btn-cam').setAttribute('aria-pressed', String(want.cam));
  $('btn-mic').setAttribute('aria-pressed', String(want.mic));
  link?.setMedia(localStream);
}

function stopMedia() {
  want.cam = want.mic = false;
  mediaJob = mediaJob.then(syncMedia);
}

for (const kind of ['cam', 'mic']) {
  $(`btn-${kind}`).addEventListener('click', () => {
    want[kind] = !want[kind];
    mediaJob = mediaJob.then(syncMedia);   // one change at a time, in order
  });
}

function showRemote(stream) {
  const video = $('video-them');
  video.srcObject = stream;
  $('videos').dataset.them = !stream ? 'off' : stream.getVideoTracks().length ? 'cam' : 'mic';
  if (stream) video.play().catch(() => toast('Tap the video to hear your opponent.'));
}
$('video-them').addEventListener('click', (event) => event.target.play().catch(() => {}));

// ── Dialogs ──────────────────────────────────────────────────────────────────
// Closing animates in CSS where the browser can transition out of the top
// layer. Elsewhere, play the exit by hand before really closing.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let displayTransitions;
function canAnimateExit() {
  if (displayTransitions === undefined) {
    displayTransitions = false;
    if (CSS.supports?.('transition-behavior', 'allow-discrete')) {
      const probe = document.createElement('div');
      probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
      document.body.append(probe);
      void getComputedStyle(probe).display;
      probe.style.display = 'none';
      displayTransitions = getComputedStyle(probe).display === 'block';
      probe.remove();
    }
  }
  return displayTransitions && CSS.supports?.('overlay', 'auto');
}

async function closeDialog(dialog) {
  if (!canAnimateExit()) {
    dialog.setAttribute('data-closing', '');
    const running = dialog.getAnimations({ subtree: true });
    if (running.length) {
      await Promise.race([Promise.allSettled(running.map((a) => a.finished)), sleep(2000)]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

for (const dialog of document.querySelectorAll('dialog')) {
  if (dialog.id === 'lost') continue;            // must be answered, not dismissed
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
  for (const button of dialog.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeDialog(dialog));
  }
}

// Click-outside-to-close where `closedby` isn't supported yet.
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
    dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, dialog)) closeDialog(dialog); });
  }
}

// ── Copy buttons ─────────────────────────────────────────────────────────────
const copyTimers = new WeakMap();
let lastCopyMessage = '';

async function copy(button, command) {
  const text = command === '--copy-link' ? inviteLink() : code;
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch { ok = false; }
  const tip = button.nextElementSibling;
  clearTimeout(copyTimers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');
  tip.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  let message = ok ? 'Copied' : 'Copy failed';
  if (message === lastCopyMessage) message += ' ';   // so screen readers repeat it
  lastCopyMessage = message;
  requestAnimationFrame(() => { tip.textContent = message; });
  copyTimers.set(button, setTimeout(() => {
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');
    tip.textContent = '';
  }, 2000));
}

if ('CommandEvent' in window) {
  // `command` events don't bubble, so listen in the capture phase.
  document.addEventListener('command', (event) => {
    if (event.command.startsWith('--copy')) copy(event.source, event.command);
  }, true);
} else {
  // Older browsers: do by hand what the command/commandfor attributes declare.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[command]');
    if (!button) return;
    const command = button.getAttribute('command');
    if (command.startsWith('--copy')) copy(button, command);
    if (command === 'show-modal') document.getElementById(button.getAttribute('commandfor'))?.showModal();
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
setLobby('idle');
// Opening an invite link in a tab that already has Gin open only changes the hash.
addEventListener('hashchange', () => {
  if (!match && !link && location.hash.length > 1) join(location.hash);
});
if (location.hash.length > 1) {
  $('join-code').value = cleanCode(location.hash);
  join(location.hash);
}

// ── Appearance: Light (the default), Dark or System, saved in this browser. The choice is written
// to <meta name="color-scheme">, which the stylesheet follows. ──
{
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  for (const input of document.querySelectorAll('input[name="scheme"]')) {
    input.checked = input.value === schemeMeta.content;
    input.addEventListener('change', () => {
      schemeMeta.content = input.value;
      try {
        // Saved even when it's System: with nothing saved, the app starts in Light.
        localStorage.setItem('gin-scheme', input.value);
      } catch { /* the choice still applies for this visit */ }
    });
  }
}
