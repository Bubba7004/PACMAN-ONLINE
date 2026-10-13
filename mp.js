/* Pac-Party multiplayer layer. Load AFTER build/app.js. Patches GameCoordinator/Ghost/Pacman prototypes.
   Host browser runs the real game; other browsers are replicas that mirror host positions. */
(() => {
const GCp = GameCoordinator.prototype, Gp = Ghost.prototype, Pp = Pacman.prototype;
const PAL = [['Yellow', 60], ['Red', 0], ['Green', 120], ['Blue', 225], ['Orange', 30], ['Purple', 275], ['Pink', 315], ['Cyan', 180]];
const LUM = { pac: .93, blinky: .3, pinky: .72, inky: .7, clyde: .75 }; // sprite brightness, evened out so every color looks equally bright
const GN = ['blinky', 'pinky', 'inky', 'clyde'];
const css = (i) => `hsl(${PAL[i][1]},100%,50%)`;
const MP = { on: false, rep: false, go: false, roles: null, snap: null };
let me, hostId, isHost = false, inRoom = false, players = {}, myColor = 0, snapTimer;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';

/* ---------- patches to the original game ---------- */
const o = {};
['startButtonClick', 'preloadAssets', 'changeDirection', 'handlePauseKey', 'handleKeyDown', 'startGameplay', 'gameOver'].forEach((n) => o[n] = GCp[n]);
GCp.preloadAssets = function () { window.GC = this; return o.preloadAssets.call(this); };
GCp.startButtonClick = function () { if (!MP.go) return; MP.go = false; return o.startButtonClick.call(this); }; // blocks the built-in auto-start
GCp.handlePauseKey = function () { if (!MP.on) return o.handlePauseKey.call(this); };                         // no pausing in a shared game
GCp.handleKeyDown = function (e) { if (typing()) return; return o.handleKeyDown.call(this, e); };
GCp.changeDirection = function (dir) { if (!MP.roles) return o.changeDirection.call(this, dir); if (!typing()) route(me, dir); };
GCp.startGameplay = function (init) {
  o.startGameplay.call(this, init);
  setTimeout(() => this.ghosts.forEach((g) => { if (g.ctrl && g.idleMode && !MP.rep) g.endIdleMode(); }), (init ? 4500 : 2000) + 600);
};
GCp.gameOver = function () { o.gameOver.call(this); if (MP.roles) setTimeout(endRound, 7000); };

const origDir = Gp.determineDirection;
Gp.determineDirection = function (name, gp, pp, dir, maze, mode) {          // player-controlled ghost
  if (!this.ctrl || mode === 'eyes') return origDir.apply(this, arguments);
  const pm = this.determinePossibleMoves(gp, dir, maze);
  if (this.want && pm[this.want]) return this.want;
  if (pm[dir]) return dir;
  return Object.keys(pm)[0] || dir;
};
const origSnapped = Gp.handleSnappedMovement;
Gp.handleSnappedMovement = function (ms, gp, v, pp) {      // player ghost: your key, else straight ahead, else STOP at the wall (like Pac-Man)
  if (!this.ctrl || this.mode === 'eyes' || gp.x % 1 !== 0 || this.isInGhostHouse(gp)) return origSnapped.apply(this, arguments); // ghost house / door: the game's own path walks you out
  const pm = this.determinePossibleMoves(gp, this.direction, this.mazeArray);
  const d = this.want && pm[this.want] ? this.want : pm[this.direction] ? this.direction : null;
  if (!d) return Object.assign({}, this.position);
  this.direction = d;
  const np = Object.assign({}, this.position);
  np[this.characterUtil.getPropertyToChange(d)] += this.characterUtil.getVelocity(d, v) * ms;
  return np;
};
['changeMode', 'becomeScared'].forEach((n) => { const f = Gp[n]; Gp[n] = function () { const d = this.direction, r = f.apply(this, arguments); if (this.ctrl) this.direction = d; return r; }; }); // game must not flip a player's ghost
function ease(ent, s, k) {
  const ts = GC.scaledTileSize, t = { top: s.t * ts, left: s.l * ts };
  if (Math.abs(t.top - ent.position.top) + Math.abs(t.left - ent.position.left) > ts * 3) ent.position = t;
  else ent.position = { top: ent.position.top + (t.top - ent.position.top) * k, left: ent.position.left + (t.left - ent.position.left) * k };
}
const gUpd = Gp.update, pUpd = Pp.update;
Gp.update = function (ms) {                                                  // replica ghosts follow the host
  if (!MP.rep) return gUpd.call(this, ms);
  this.oldPosition = Object.assign({}, this.position);
  const s = MP.snap && MP.snap[this.name];
  if (s) { ease(this, s, 0.18); this.direction = s.d; this.mode = s.m; this.setSpriteSheet(this.name, this.direction, this.mode); }
  this.msSinceLastSprite += ms;
};
Pp.update = function (ms) {
  if (!MP.rep) return pUpd.call(this, ms);
  this.oldPosition = Object.assign({}, this.position);
  const s = MP.snap && MP.snap.pac;
  if (s) { ease(this, s, 0.18); if (s.d !== this.direction) { this.direction = s.d; this.setSpriteSheet(s.d); } }
  if (this.moving || this.specialAnimation) this.msSinceLastSprite += ms;
};
window.addEventListener('deathSequence', () => { if (MP.on && !MP.rep) bcast({ k: 'ev', n: 'death' }); });
window.addEventListener('eatGhost', (e) => { if (MP.on && !MP.rep) bcast({ k: 'ev', n: 'eat', g: e.detail.ghost.name }); });

/* ---------- input routing ---------- */
function route(id, dir) { if (isHost || !MP.on) apply(id, dir); else toHost({ k: 'dir', d: dir }); }
function apply(id, dir) {
  if (!GC.allowKeyPresses || !GC.gameEngine.running) return;
  if (id === MP.roles.pac) GC.pacman.changeDirection(dir, GC.allowPacmanMovement);
  else {
    const g = GC.ghosts.find((x) => x.ctrl === id); if (!g) return; g.want = dir;
    const gp = g.characterUtil.determineGridPosition(g.position, g.scaledTileSize);
    if (!g.idleMode && g.mode !== 'eyes' && gp.x % 1 === 0 && !g.isInGhostHouse(gp) && dir === g.characterUtil.getOppositeDirection(g.direction)) g.direction = dir; // reverse instantly
  }
}
function snapshot() {
  const ts = GC.scaledTileSize, f = (e, m) => ({ t: e.position.top / ts, l: e.position.left / ts, d: e.direction, m: m && e.mode });
  const s = { pac: f(GC.pacman) }; GC.ghosts.forEach((g) => s[g.name] = f(g, 1)); return s;
}

/* ---------- networking: PeerJS. Its free public broker only does the handshake (4-char code); game data flows device-to-device ---------- */
const peers = {}; let hostCh = null, nextPeer = 1, peer = null;
const sendAll = (d) => Object.values(peers).forEach((p) => p.ch.open && p.ch.send(d));
const toHost = (d) => isHost ? hostRecv(me, d) : hostCh && hostCh.open && hostCh.send(d);
const bcast = (d) => { if (isHost) sendAll(d); recv(d); };
const loadPeerJs = () => window.Peer ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'; s.onload = ok; s.onerror = no; document.head.append(s); });
const NET_ERR = 'Could not reach the matchmaking service. Make sure you are connected to the internet/Wi-Fi.';
const enter = (title) => { inRoom = true; players = {}; $('mp-rt').textContent = title; $('mp-log').innerHTML = ''; $('mp-chat').hidden = false; view('lobby'); };
async function hostRoom() {
  try { await loadPeerJs(); } catch (e) { return alert(NET_ERR); }
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const tryCode = () => {
    const code = Array.from({ length: 4 }, () => A[Math.random() * A.length | 0]).join(''), p = new Peer('pacparty-' + code, { debug: 0 });
    p.on('open', () => { peer = p; isHost = true; me = 'host'; hostId = 'host'; $('mp-big').textContent = code; enter('Your game'); hostRecv(me, { k: 'hello', n: nm(), c: myColor }); });
    p.on('error', (e) => e.type === 'unavailable-id' ? tryCode() : alert(NET_ERR));
    p.on('connection', (c) => {
      const id = 'p' + nextPeer++;
      c.on('open', () => { if (MP.on || Object.keys(peers).length >= 4) return c.close(); peers[id] = { ch: c }; c.send({ k: 'welcome', id }); });
      c.on('data', (d) => peers[id] && hostRecv(id, d));
      c.on('close', () => { if (peers[id]) { delete peers[id]; hostRecv(id, { k: 'gone' }); } });
    });
  };
  tryCode();
}
async function joinRoom() {
  const code = $('mp-code').value.trim().toUpperCase(); if (code.length !== 4) return alert('Enter the 4-character code.');
  try { await loadPeerJs(); } catch (e) { return alert(NET_ERR); }
  const p = new Peer({ debug: 0 }); let ok = false;
  p.on('error', (e) => { if (!ok) alert(e.type === 'peer-unavailable' ? 'No game found with that code.' : NET_ERR); });
  p.on('open', () => {
    const c = p.connect('pacparty-' + code, { serialization: 'json', reliable: true }); hostCh = c;
    c.on('data', (d) => { if (d.k === 'welcome') { ok = true; peer = p; me = d.id; hostId = 'host'; isHost = false; enter('Joined ' + code); toHost({ k: 'hello', n: nm(), c: myColor }); } else recv(d); });
    c.on('close', () => { if (ok) { alert('Disconnected from the host.'); location.reload(); } });
  });
}
const takenBy = (c, except) => Object.values(players).some((p) => p.color === c && p.id !== except);
function pushLobby() { bcast({ k: 'lobby', players, host: hostId }); }
function hostRecv(from, d) {
  if (d.k === 'hello') { let c = d.c; if (takenBy(c)) c = PAL.findIndex((_, i) => !takenBy(i)); players[from] = { id: from, name: String(d.n || 'Player').slice(0, 12), color: c }; pushLobby(); bcast({ k: 'chat', n: '*', c: '#888', x: players[from].name + ' joined' }); }
  else if (d.k === 'color') { if (players[from] && PAL[d.c] && !takenBy(d.c)) { players[from].color = d.c; pushLobby(); } }
  else if (d.k === 'chat') { const p = players[from]; if (p) bcast({ k: 'chat', n: p.name, c: css(p.color), x: String(d.x).slice(0, 120) }); }
  else if (d.k === 'dir') { if (MP.on) apply(from, d.d); }
  else if (d.k === 'gone') { const g = MP.on && GC.ghosts.find((x) => x.ctrl === from); if (g) g.ctrl = null; delete players[from]; pushLobby(); }
}
function recv(d) {
  if (d.k === 'lobby') { players = d.players; hostId = d.host; drawLobby(); }
  else if (d.k === 'chat') { const l = $('mp-log'), e = document.createElement('div'); e.innerHTML = `<b style="color:${d.c}">${esc(d.n)}</b> ${esc(d.x)}`; l.append(e); l.scrollTop = 1e9; }
  else if (d.k === 'start') runSlot(d);
  else if (d.k === 's') { if (MP.rep) MP.snap = d.s; }
  else if (d.k === 'ev' && MP.rep) { if (d.n === 'death') window.dispatchEvent(new Event('deathSequence')); else window.dispatchEvent(new CustomEvent('eatGhost', { detail: { ghost: GC[d.g] } })); }
}

/* ---------- lobby, slot machine, round flow ---------- */
function startGame() {
  const ids = Object.keys(players); if (ids.length < 2) return;
  const pac = ids[Math.random() * ids.length | 0], gh = {}; let i = 0; ids.forEach((id) => { if (id !== pac) gh[id] = GN[i++]; });
  bcast({ k: 'start', pac, gh });
}
function runSlot(d) {
  view('slot'); const ids = Object.keys(players), L = ids.length, ti = ids.indexOf(d.pac); $('mp-res').textContent = ''; let done = 0;
  [...document.querySelectorAll('.mp-reel')].forEach((el, r) => { const N = 16 + r * 6; let idx = ((ti - N) % L + L) % L, i = 0;
    (function step() { const p = players[ids[idx % L]]; el.textContent = p ? p.name : '?'; el.style.color = p ? css(p.color) : '#000';
      if (i++ < N) { idx++; setTimeout(step, 40 + i * i * .3); }
      else if (++done === 3) { $('mp-res').textContent = (p ? p.name : '?').toUpperCase() + ' IS PAC-MAN! EVERYONE ELSE: GHOSTS!'; setTimeout(() => begin(d), 1400); } })(); });
}
function begin(d) {
  MP.on = true; MP.rep = !isHost; MP.roles = { pac: d.pac, gh: d.gh }; MP.snap = null; MP.go = true; GC.startButtonClick();
  GC.ghosts.forEach((g) => { g.ctrl = null; g.want = null; });
  Object.entries(d.gh).forEach(([id, n]) => { GC[n].ctrl = id; });
  if (document.activeElement) document.activeElement.blur();
  const r = $('mp-role'); r.textContent = d.pac === me ? 'YOU ARE PAC-MAN' : 'YOU ARE ' + (d.gh[me] || '?').toUpperCase() + ' - CATCH PAC-MAN'; r.hidden = false; setTimeout(() => r.hidden = true, 7000);
  view(null); if (isHost) snapTimer = setInterval(() => bcast({ k: 's', s: snapshot() }), 33);
}
function endRound() {
  clearInterval(snapTimer); MP.on = false; MP.rep = false; MP.roles = null;
  if (inRoom) { view('lobby'); if (isHost) pushLobby(); } else view('menu');
}
function solo() { players = { me: { id: 'me', name: nm(), color: myColor } }; me = 'me'; isHost = true; MP.roles = { pac: 'me', gh: {} }; MP.go = true; GC.startButtonClick(); GC.ghosts.forEach((g) => g.ctrl = null); view(null); }

/* ---------- name labels + color tint above characters ---------- */
function labels() {
  requestAnimationFrame(labels);
  const maze = document.getElementById('maze'); if (!MP.roles || !window.GC || !GC.pacman || !maze) return;
  const ents = [['pac', GC.pacman, MP.roles.pac], ...GC.ghosts.map((g) => [g.name, g, Object.keys(MP.roles.gh).find((id) => MP.roles.gh[id] === g.name)])];
  ents.forEach(([k, e, id]) => {
    const el = e.animationTarget, p = players[id]; let lab = document.getElementById('mp-l-' + k);
    if (!lab) { lab = document.createElement('div'); lab.id = 'mp-l-' + k; lab.className = 'mp-label'; maze.append(lab); }
    if (!p) { lab.style.display = 'none'; el.style.filter = ''; return; }
    lab.textContent = p.name; lab.style.color = css(p.color); lab.style.fontSize = GC.scaledTileSize * .8 + 'px';
    lab.style.display = el.style.visibility === 'hidden' ? 'none' : 'block';
    lab.style.left = parseFloat(el.style.left) + GC.scaledTileSize + 'px'; lab.style.top = parseFloat(el.style.top) - GC.scaledTileSize * .6 + 'px';
    el.style.filter = (k !== 'pac' && (e.mode === 'scared' || e.mode === 'eyes')) ? '' : `grayscale(1) brightness(${(.68 / LUM[k]).toFixed(2)}) sepia(1) saturate(4) hue-rotate(${PAL[p.color][1] - 39}deg)`;
  });
}

/* ---------- UI ---------- */
const $ = (id) => document.getElementById(id), nm = () => ($('mp-nm').value.trim() || 'Player').slice(0, 12);
function view(v) { $('mp-ov').hidden = !v; ['menu', 'lobby', 'slot'].forEach((x) => $('mp-' + x).hidden = x !== v); }
function palette(box, mine, take, pick) {
  box.innerHTML = ''; PAL.forEach((_, i) => { const b = document.createElement('button'); b.className = 'mp-sw' + (i === mine ? ' me' : ''); b.style.background = css(i); b.disabled = take(i) && i !== mine; b.onclick = () => pick(i); box.append(b); });
}
function drawLobby() {
  $('mp-pls').innerHTML = Object.values(players).map((p) => `<div class="mp-pl"><span class="mp-dot" style="background:${css(p.color)}"></span>${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.id === me ? ' (you)' : ''}</div>`).join('');
  const mine = players[me]; if (mine) { myColor = mine.color; palette($('mp-pal'), mine.color, (i) => takenBy(i, me), (i) => toHost({ k: 'color', c: i })); }
  const n = Object.keys(players).length; $('mp-go').hidden = !isHost; $('mp-inv').hidden = !isHost; $('mp-go').disabled = n < 2;
  $('mp-hint').textContent = isHost ? (n < 2 ? 'Need 2+ players. Share the join code.' : 'Empty ghost slots stay AI-controlled.') : 'Waiting for the host to start...';
}
function build() {
  const st = document.createElement('style');
  st.textContent = `#mp-ov[hidden],#mp-chat[hidden],#mp-role[hidden]{display:none!important}
#mp-ov{position:fixed;inset:0;background:#000d;z-index:9999;display:flex;align-items:center;justify-content:center;font:11px/1.8 'Press Start 2P',monospace;color:#fff}
#mp-ov>div{background:#000;border:5px solid #2121ff;border-radius:10px;padding:18px;width:min(94vw,520px);max-height:94vh;overflow:auto;text-align:center}
#mp-ov img{width:100%;max-width:320px;margin-bottom:8px}
#mp-ov button,#mp-chat button{font:inherit;cursor:pointer;background:#fcc73f;color:#231f20;border:4px solid #231f20;border-radius:8px;box-shadow:4px 4px #ee2a29;padding:10px 14px;margin:6px 4px}
#mp-ov button:active{box-shadow:none;transform:translate(4px,4px)}#mp-ov button:disabled{opacity:.4;cursor:default;box-shadow:none;transform:none}
#mp-ov input,#mp-chat input{font:inherit;background:#000;color:#fff;border:3px solid #2121ff;border-radius:6px;padding:10px;width:100%;margin:6px 0;outline:none;min-width:0}
#mp-ov input:focus,#mp-chat input:focus{border-color:#fcc73f}
.mp-h{color:#fcc73f;margin:16px 0 4px}.mp-sub{color:#8f8fff;font-size:9px;line-height:1.8}.mp-row{display:flex;gap:6px;align-items:center}.mp-row button{margin:6px 0;white-space:nowrap}
#mp-ov .mp-sw{width:30px;height:30px;border-radius:50%;padding:0;margin:4px;border:4px solid #222;box-shadow:none}#mp-ov .mp-sw.me{border-color:#fff}#mp-ov .mp-sw:disabled{opacity:.15}
.mp-pl{display:flex;align-items:center;justify-content:center;padding:4px 0}.mp-dot{display:inline-block;width:16px;height:16px;border-radius:50%;margin-right:10px;border:3px solid #fff}
.mp-reels{display:flex;gap:8px;justify-content:center;background:#ee2a29;border:5px solid #fcc73f;padding:12px;border-radius:12px;margin:12px 0}
.mp-reel{width:31%;height:48px;background:#fff;color:#000;display:flex;align-items:center;justify-content:center;font-size:9px;overflow:hidden;border:3px solid #231f20}
#mp-big{font-size:34px;letter-spacing:10px;color:#fff;border:3px dashed #fcc73f;border-radius:8px;padding:10px 0 10px 10px;margin:8px 0}
#mp-res{color:#fcc73f;margin-top:14px;min-height:56px;line-height:2}
#mp-role{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;color:#fcc73f;text-shadow:2px 2px #000;font:11px 'Press Start 2P',monospace;white-space:nowrap;pointer-events:none}
.mp-label{position:absolute;transform:translateX(-50%);font-family:'Press Start 2P',monospace;pointer-events:none;z-index:60;white-space:nowrap;text-shadow:-1px -1px #000,1px 1px #000,1px -1px #000,-1px 1px #000}
#mp-chat{position:fixed;left:8px;bottom:8px;width:min(46vw,270px);z-index:10000;background:#000c;border:3px solid #2121ff;border-radius:8px;padding:8px;color:#fff;font:8px/1.9 'Press Start 2P',monospace}
#mp-log{height:96px;overflow:auto;word-break:break-word}#mp-chat input{font-size:8px;padding:7px;margin:4px 0 0}`;
  document.head.append(st);
  const ov = document.createElement('div'); ov.id = 'mp-ov';
  ov.innerHTML = `<div id="mp-menu"><img src="app/style/graphics/pacman_logo.png" alt="PAC-MAN"><input id="mp-nm" maxlength="12" placeholder="YOUR NAME">
    <div class="mp-h">YOUR COLOR</div><div id="mp-mypal"></div>
    <button id="mp-solo">SOLO</button><button id="mp-mk">HOST GAME</button>
    <div class="mp-h">JOIN A GAME</div><div class="mp-row"><input id="mp-code" placeholder="CODE" maxlength="4" style="text-transform:uppercase;text-align:center;font-size:16px"><button id="mp-join">JOIN</button></div>
    <p id="mp-wait" class="mp-sub">Loading game assets...</p></div>
   <div id="mp-lobby" hidden><div class="mp-h" id="mp-rt"></div><div id="mp-pls"></div><div class="mp-h">YOUR COLOR</div><div id="mp-pal"></div>
    <div id="mp-inv"><div class="mp-h">JOIN CODE</div><div id="mp-big"></div><div class="mp-sub">Friends type this on the main menu</div></div>
    <button id="mp-go">START</button><button id="mp-lv">LEAVE</button><div id="mp-hint" class="mp-sub"></div></div>
   <div id="mp-slot" hidden><div class="mp-h">WHO IS PAC-MAN?</div><div class="mp-reels"><div class="mp-reel"></div><div class="mp-reel"></div><div class="mp-reel"></div></div><div id="mp-res"></div></div>`;
  document.body.append(ov); const rl = document.createElement('div'); rl.id = 'mp-role'; rl.hidden = true; document.body.append(rl);
  const ch = document.createElement('div'); ch.id = 'mp-chat'; ch.hidden = true; ch.innerHTML = '<div id="mp-log"></div><input id="mp-ci" maxlength="120" placeholder="ENTER = CHAT">'; document.body.append(ch);
  $('mp-nm').value = localStorage.mpName || ''; $('mp-nm').onchange = () => localStorage.mpName = nm();
  const pal = () => palette($('mp-mypal'), myColor, () => false, (i) => { myColor = i; pal(); }); pal();
  $('mp-solo').onclick = solo; $('mp-mk').onclick = hostRoom; $('mp-join').onclick = joinRoom;
  $('mp-code').onkeydown = (e) => { if (e.key === 'Enter') joinRoom(); };
  $('mp-go').onclick = startGame; $('mp-lv').onclick = () => location.reload();
  $('mp-ci').onkeydown = (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) toHost({ k: 'chat', x: v }); e.target.value = ''; if (MP.on) e.target.blur(); } if (e.key === 'Escape') e.target.blur(); };
  addEventListener('keydown', (e) => { if (e.key === 'Enter' && inRoom && !typing()) { $('mp-ci').focus(); e.preventDefault(); } });
  const t = setInterval(() => { if (!document.getElementById('loading-container') && window.GC) { $('mp-wait').remove(); clearInterval(t); } }, 300); // assets ready
  $('mp-solo').disabled = true; const t2 = setInterval(() => { if (!$('mp-wait')) { $('mp-solo').disabled = false; clearInterval(t2); } }, 300);
  let ts; addEventListener('touchstart', (e) => ts = e.touches[0], { passive: true });
  addEventListener('touchend', (e) => { if (!MP.roles || !ts || e.target.closest('#mp-chat,#mp-ov')) return; const t = e.changedTouches[0], x = t.clientX - ts.clientX, y = t.clientY - ts.clientY;
    if (Math.max(Math.abs(x), Math.abs(y)) > 25) GC.changeDirection(Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up')); }, { passive: true });
}
const init = () => { build(); labels(); };
document.readyState === 'loading' ? addEventListener('DOMContentLoaded', init) : init();
})();
