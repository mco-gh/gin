# Gin

Peer-to-peer gin rummy for two, played in the browser at [mco.dev/gin](https://mco.dev/gin/). Start a game, share the code with a friend and deal; there is nothing to sign up for, and you can turn on video or chat while you play.

It is a static app with no build step: open `index.html` from any web server. The two players connect directly to each other using [PeerJS](https://peerjs.com/) (vendored in `vendor/`).

- `gin.js` is the rules: melds, deadwood, knocking, laying off, gin, big gin, undercuts and match scoring.
- `table.js` draws the table. Each of the 52 cards is its own element, positioned with CSS variables, so a card's trip from the stock to a hand or the pile is a CSS transition.
- `app.js` runs the lobby, the turns, chat, video and settings; `net.js` and `ice.js` make the connection.

Both browsers keep an identical copy of the match. The host shuffles (with `crypto.getRandomValues`) and sends each new hand; every action is sent to the other browser, which checks it against its own copy before applying it, and asks for a fresh copy if they ever disagree. The page only ever shows you your own cards, but because both browsers hold the deck it is a game for friends, not strangers.

This repo is mounted in [mco-gh/mco.dev](https://github.com/mco-gh/mco.dev) as a git submodule at `static/gin`. After pushing a change here, update the submodule pointer there to publish it:

```bash
cd mco.dev
git submodule update --remote static/gin
git commit -am "Update gin"
git push
```

## Install on a phone

The app is an installable web app: `manifest.webmanifest` describes it, and `sw.js`
is a network-first service worker, so it is always current when online and still
opens offline. Nothing needs bumping on release. The icons in `icons/` are rendered
from the SVG sources by `bash build/icons/render.sh` (needs Google Chrome).

## Connecting through firewalls

Two browsers usually connect directly, with help from a public STUN server. When they
can't (mobile data, strict routers, browsers that block local connections), a TURN
relay carries the traffic. `ice.js` fetches short-lived relay credentials from
`/api/turn`, a Netlify Function in the mco.dev repo that asks Cloudflare for them;
if that isn't available it falls back to STUN only. If no route forms within 20
seconds, the app says so instead of waiting forever.
