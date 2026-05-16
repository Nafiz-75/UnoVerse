const app = document.querySelector("#app");
const toastEl = document.querySelector("#toast");

const COLORS = ["red", "blue", "green", "yellow"];
const MODES = {
  mercy: {
    label: "UNO No Mercy",
    blurb: "Stacking, harsh draw pressure, forced skips, and elimination at 25 cards.",
    maxHand: 25,
  },
  flip: {
    label: "UNO Flip",
    blurb: "Light and dark decks with Flip cards that invert the whole table.",
    maxHand: 30,
  },
  wild: {
    label: "UNO All Wild",
    blurb: "Every card is wild: color calling, targeted draws, skips, reverses, and swaps.",
    maxHand: 28,
  },
};

const adjectives = ["NOVA", "VOLT", "ASTRO", "LUX", "RIFT", "FIRE", "ZEN", "ORBIT", "ECHO", "WILD"];
const nouns = ["UNO", "COMET", "SPARK", "VERSE", "FLIP", "MERCY", "PULSE", "STACK", "GLOW", "CARD"];
let clientId = sessionStorage.getItem("unoverse:clientId");
if (!clientId) {
  clientId = crypto.randomUUID();
  sessionStorage.setItem("unoverse:clientId", clientId);
}

let roomCode = new URLSearchParams(location.search).get("room") || "";
let view = "entry";
let entryMode = roomCode ? "join" : "create";
let selectedMode = "mercy";
let selectedCardId = null;
let pendingWild = null;
let eliminationNotice = null;
let audioOn = localStorage.getItem("unoverse:audio") !== "off";
let state = null;
let lastSeenVersion = 0;
let firebaseDB = null;
let roomListener = null;

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function toArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.keys(val).sort((a, b) => Number(a) - Number(b)).map((k) => val[k]);
}

function fromFirebase(raw) {
  if (!raw) return raw;
  const s = { ...raw };
  s.players = toArr(s.players).map((p) => ({ ...p, hand: toArr(p.hand) }));
  s.chat = toArr(s.chat);
  s.spectators = toArr(s.spectators || []);
  if (s.game) {
    s.game = { ...s.game };
    s.game.deck = toArr(s.game.deck);
    s.game.discard = toArr(s.game.discard);
    s.game.log = toArr(s.game.log || []);
  }
  return s;
}

function makeRoomCode() {
  return `${pick(adjectives)}-${pick(nouns)}-${Math.floor(100 + Math.random() * 900)}`;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function roomKey(code = roomCode) {
  return (code || roomCode).toUpperCase().replace(/-/g, "_");
}

function readRoom() {
  return state;
}

function writeRoom(next) {
  next.version = (next.version || 0) + 1;
  next.updatedAt = Date.now();
  state = next;
  lastSeenVersion = next.version;
  render();
  if (firebaseDB) {
    firebaseDB.ref(`rooms/${roomKey()}`).set(next).catch((err) => {
      console.error("Firebase write failed:", err);
      toast("Sync error — check your connection.");
    });
  }
}

function connectRoom(code) {
  roomCode = code.toUpperCase();
  if (roomListener && firebaseDB) {
    firebaseDB.ref(`rooms/${roomKey()}`).off("value", roomListener);
    roomListener = null;
  }
  state = null;
  lastSeenVersion = 0;
  if (!firebaseDB) {
    toast("Firebase not ready. Refresh the page.");
    return;
  }
  roomListener = firebaseDB.ref(`rooms/${roomKey()}`).on(
    "value",
    (snapshot) => {
      const remote = fromFirebase(snapshot.val());
      if (!remote) return;
      if ((remote.version || 0) <= lastSeenVersion && state) return;
      state = remote;
      lastSeenVersion = state.version || 0;
      if (me()) view = state.phase === "game" ? "game" : "lobby";
      render();
    },
    (err) => {
      console.error("Firebase listener error:", err);
      toast("Connection lost — refresh to reconnect.");
    }
  );
}

function me() {
  return state?.players.find((player) => player.id === clientId);
}

function isHost() {
  return state?.hostId === clientId;
}

function createRoom({ name, gender }) {
  const code = makeRoomCode();
  connectRoom(code);
  const player = makePlayer(name, gender, true);
  const next = {
    code,
    hostId: clientId,
    mode: selectedMode,
    phase: "lobby",
    players: [player],
    spectators: [],
    chat: systemChat(`${name} opened the table.`),
    game: null,
    version: 0,
    updatedAt: Date.now(),
  };
  history.replaceState(null, "", `?room=${code}`);
  view = "lobby";
  writeRoom(next);
}

async function joinRoom({ name, gender, code }) {
  const normalized = code.trim().toUpperCase();
  view = "joining";
  render();
  try {
    if (!firebaseDB) throw new Error("Firebase not ready — check your databaseURL in index.html");
    const snapshot = await firebaseDB.ref(`rooms/${roomKey(normalized)}`).get();
    const existing = fromFirebase(snapshot.val());
    if (!existing) {
      toast("Room not found. Double-check the room code.");
      view = "entry";
      render();
      return;
    }
    connectRoom(normalized);
    const already = existing.players.some((player) => player.id === clientId);
    if (!already) {
      existing.players.push(makePlayer(name, gender, false));
      existing.chat.push(...systemChat(`${name} joined the room.`));
    }
    history.replaceState(null, "", `?room=${normalized}`);
    view = existing.phase === "game" ? "game" : "lobby";
    writeRoom(existing);
  } catch (err) {
    console.error("Join failed:", err);
    const msg = err.code === "PERMISSION_DENIED"
      ? "Firebase rules blocking access — check database.rules.json in Firebase Console."
      : err.message || "Could not join room — check the code and your connection.";
    toast(msg);
    view = "entry";
    render();
  }
}

function makePlayer(name, gender, host) {
  return {
    id: clientId,
    name: name.trim().slice(0, 24),
    gender,
    host,
    hand: [],
    uno: false,
    eliminated: false,
    spectator: false,
    joinedAt: Date.now(),
  };
}

function systemChat(text) {
  return [
    {
      id: uid("msg"),
      playerId: "system",
      name: "UnoVerse",
      text,
      at: Date.now(),
    },
  ];
}

function startGame() {
  if (!isHost() || state.players.length < 2) {
    toast("Need at least two players to start.");
    return;
  }
  const next = structuredClone(state);
  const deck = shuffle(buildDeck(next.mode));
  next.players.forEach((player) => {
    player.hand = [];
    player.uno = false;
    player.eliminated = false;
    player.spectator = false;
    for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
  });
  let discard = deck.pop();
  while (discard.type === "wild" || discard.type === "wildDraw" || discard.type === "flip") {
    deck.unshift(discard);
    discard = deck.pop();
  }
  next.phase = "game";
  next.game = {
    deck,
    discard: [discard],
    currentColor: discard.color || "red",
    currentSide: "light",
    turn: 0,
    direction: 1,
    drawStack: 0,
    chosenTarget: null,
    winnerId: null,
    startedAt: Date.now(),
    log: [`${MODES[next.mode].label} started.`],
  };
  next.chat.push(...systemChat(`Game started in ${MODES[next.mode].label}.`));
  view = "game";
  writeRoom(next);
  playSound("start");
}

function endGame(reason = "The organizer ended the game.") {
  if (!isHost()) return;
  const next = structuredClone(state);
  next.phase = "lobby";
  next.game = null;
  next.players.forEach((player) => {
    player.hand = [];
    player.uno = false;
    player.eliminated = false;
    player.spectator = false;
  });
  next.chat.push(...systemChat(reason));
  view = "lobby";
  writeRoom(next);
}

function buildDeck(mode) {
  if (mode === "wild") return buildAllWildDeck();
  if (mode === "flip") return buildFlipDeck();
  return buildMercyDeck();
}

function buildMercyDeck() {
  const deck = [];
  COLORS.forEach((color) => {
    for (let n = 0; n <= 9; n++) deck.push(card(color, "number", String(n)));
    ["skip", "reverse", "draw2", "skipAll", "draw4color"].forEach((type) => {
      deck.push(card(color, type, labelFor(type)));
      deck.push(card(color, type, labelFor(type)));
    });
  });
  for (let i = 0; i < 8; i++) deck.push(card("wild", "wild", "WILD"));
  for (let i = 0; i < 8; i++) deck.push(card("wild", "wildDraw", "+6"));
  for (let i = 0; i < 4; i++) deck.push(card("wild", "wildDraw", "+10"));
  return deck;
}

function buildFlipDeck() {
  const deck = [];
  COLORS.forEach((color) => {
    for (let n = 0; n <= 9; n++) deck.push(card(color, "number", String(n), { darkColor: darkFor(color), darkLabel: String(n) }));
    ["skip", "reverse", "draw1", "flip"].forEach((type) => {
      deck.push(card(color, type, labelFor(type), { darkColor: darkFor(color), darkLabel: darkLabelFor(type) }));
      deck.push(card(color, type, labelFor(type), { darkColor: darkFor(color), darkLabel: darkLabelFor(type) }));
    });
  });
  for (let i = 0; i < 4; i++) deck.push(card("wild", "wild", "WILD", { darkColor: "wild", darkLabel: "WILD" }));
  for (let i = 0; i < 4; i++) deck.push(card("wild", "wildDraw", "+2", { darkColor: "wild", darkLabel: "+5" }));
  return deck;
}

function buildAllWildDeck() {
  const types = ["wild", "wildDraw", "wildDraw", "skip", "reverse", "skipAll", "swap"];
  return Array.from({ length: 112 }, (_, index) => card("wild", types[index % types.length], labelFor(types[index % types.length], true)));
}

function card(color, type, label, extra = {}) {
  return { id: uid("card"), color, type, label, ...extra };
}

function labelFor(type, allWild = false) {
  return {
    skip: allWild ? "SKIP" : "⊘",
    reverse: "↺",
    draw1: "+1",
    draw2: "+2",
    draw4color: "+4",
    skipAll: "ALL",
    wild: "WILD",
    wildDraw: allWild ? "+2" : "+6",
    swap: "SWAP",
    flip: "FLIP",
  }[type] || type;
}

function darkFor(color) {
  return { red: "blue", blue: "green", green: "yellow", yellow: "red" }[color];
}

function darkLabelFor(type) {
  return { draw1: "+5", flip: "FLIP", skip: "⊘", reverse: "↺" }[type] || labelFor(type);
}

function visibleCard(rawCard) {
  if (!state?.game || state.mode !== "flip" || state.game.currentSide === "light") return rawCard;
  return {
    ...rawCard,
    color: rawCard.darkColor || rawCard.color,
    label: rawCard.darkLabel || rawCard.label,
    dark: true,
  };
}

function topCard() {
  return visibleCard(state.game.discard.at(-1));
}

function activePlayer() {
  if (!state?.game) return null;
  return state.players[state.game.turn];
}

function canPlay(rawCard, player = me()) {
  if (!state?.game || !player || activePlayer()?.id !== player.id || player.eliminated) return false;
  const cardView = visibleCard(rawCard);
  if (state.game.drawStack > 0) return isStackable(cardView);
  if (state.mode === "wild") return true;
  const top = topCard();
  return cardView.color === "wild" || cardView.color === state.game.currentColor || cardView.label === top.label || cardView.type === top.type;
}

function isStackable(cardView) {
  return ["draw1", "draw2", "draw4color", "wildDraw"].includes(cardView.type);
}

function playCard(cardId, chosenColor = null) {
  const player = me();
  const rawCard = player?.hand.find((candidate) => candidate.id === cardId);
  if (!rawCard || !canPlay(rawCard, player)) {
    toast("That card cannot be played right now.");
    return;
  }
  const cardView = visibleCard(rawCard);
  if ((cardView.color === "wild" || state.mode === "wild") && !chosenColor) {
    pendingWild = cardId;
    render();
    return;
  }
  const next = structuredClone(state);
  const actor = next.players.find((candidate) => candidate.id === clientId);
  const played = actor.hand.splice(actor.hand.findIndex((candidate) => candidate.id === cardId), 1)[0];
  next.game.discard.push(played);
  next.game.currentColor = chosenColor || visibleFor(next, played).color;
  actor.uno = actor.hand.length === 1 ? actor.uno : false;
  applyCardEffect(next, actor, visibleFor(next, played));
  if (actor.hand.length === 0) {
    next.game.winnerId = actor.id;
    next.phase = "lobby";
    next.chat.push(...systemChat(`${actor.name} wins the round.`));
    next.players.forEach((p) => {
      p.hand = [];
      p.uno = false;
      p.eliminated = false;
    });
    next.game = null;
    view = "lobby";
    playSound("win");
  } else {
    enforceEliminations(next);
    if (next.phase === "game") advancePastEliminated(next);
  }
  pendingWild = null;
  selectedCardId = null;
  animatePlayedCard(cardView);
  playSound(cardView.type.includes("wild") ? "wild" : "play");
  writeRoom(next);
}

function visibleFor(next, rawCard) {
  if (next.mode !== "flip" || next.game.currentSide === "light") return rawCard;
  return {
    ...rawCard,
    color: rawCard.darkColor || rawCard.color,
    label: rawCard.darkLabel || rawCard.label,
    dark: true,
  };
}

function applyCardEffect(next, actor, cardView) {
  const count = drawCount(next, cardView);
  if (count) {
    next.game.drawStack += count;
    next.game.turn = nextPlayerIndex(next, next.game.turn);
    return;
  }
  if (cardView.type === "skip") {
    next.game.turn = nextPlayerIndex(next, nextPlayerIndex(next, next.game.turn));
    return;
  }
  if (cardView.type === "skipAll") {
    next.game.turn = next.players.findIndex((candidate) => candidate.id === actor.id);
    return;
  }
  if (cardView.type === "reverse") {
    next.game.direction *= -1;
    next.game.turn = nextPlayerIndex(next, next.game.turn);
    return;
  }
  if (cardView.type === "flip") {
    next.game.currentSide = next.game.currentSide === "light" ? "dark" : "light";
    next.game.turn = nextPlayerIndex(next, next.game.turn);
    return;
  }
  if (cardView.type === "swap") {
    const target = next.players.filter((player) => !player.eliminated && player.id !== actor.id).sort((a, b) => b.hand.length - a.hand.length)[0];
    if (target) [actor.hand, target.hand] = [target.hand, actor.hand];
  }
  next.game.turn = nextPlayerIndex(next, next.game.turn);
}

function drawCount(next, cardView) {
  if (cardView.type === "draw1") return next.game.currentSide === "dark" ? 5 : 1;
  if (cardView.type === "draw2") return 2;
  if (cardView.type === "draw4color") return 4;
  if (cardView.type === "wildDraw") {
    if (next.mode === "wild") return 2;
    if (next.mode === "flip") return next.game.currentSide === "dark" ? 5 : 2;
    return cardView.label === "+10" ? 10 : 6;
  }
  return 0;
}

function drawCard(forceCount = 1) {
  const player = me();
  if (!state?.game || activePlayer()?.id !== clientId || player.eliminated) return;
  const next = structuredClone(state);
  const actor = next.players.find((candidate) => candidate.id === clientId);
  const count = next.game.drawStack || forceCount;
  for (let i = 0; i < count; i++) actor.hand.push(takeFromDeck(next));
  actor.uno = false;
  next.game.drawStack = 0;
  next.game.turn = nextPlayerIndex(next, next.game.turn);
  enforceEliminations(next);
  advancePastEliminated(next);
  playSound("draw");
  writeRoom(next);
}

function takeFromDeck(next) {
  if (next.game.deck.length === 0) {
    const keep = next.game.discard.pop();
    next.game.deck = shuffle(next.game.discard);
    next.game.discard = [keep];
  }
  return next.game.deck.pop();
}

function nextPlayerIndex(next, from) {
  if (!next.players.some((player) => !player.eliminated)) return from;
  let index = from;
  do {
    index = (index + next.game.direction + next.players.length) % next.players.length;
  } while (next.players[index].eliminated);
  return index;
}

function advancePastEliminated(next) {
  if (!next.players.some((player) => !player.eliminated)) {
    next.phase = "lobby";
    next.chat.push(...systemChat("The table ended with no active players."));
    next.game = null;
    return;
  }
  if (next.players[next.game.turn]?.eliminated) next.game.turn = nextPlayerIndex(next, next.game.turn);
}

function enforceEliminations(next) {
  const max = MODES[next.mode].maxHand;
  next.players.forEach((player) => {
    if (!player.eliminated && player.hand.length >= max) {
      player.eliminated = true;
      player.spectator = true;
      eliminationNotice = `${player.name} was eliminated at ${player.hand.length} cards`;
      next.chat.push(...systemChat(`${player.name} was eliminated and is now spectating.`));
      playSound("eliminate");
      setTimeout(() => {
        eliminationNotice = null;
        render();
      }, 2800);
    }
  });
}

function callUno() {
  const next = structuredClone(state);
  const actor = next.players.find((candidate) => candidate.id === clientId);
  if (!actor || actor.hand.length !== 1) {
    toast("UNO can only be called when you have one card.");
    return;
  }
  actor.uno = true;
  next.chat.push(...systemChat(`${actor.name} called UNO!`));
  playSound("uno");
  writeRoom(next);
}

function catchUno(playerId) {
  const target = state.players.find((player) => player.id === playerId);
  if (!target || target.hand.length !== 1 || target.uno) return;
  const next = structuredClone(state);
  const caught = next.players.find((player) => player.id === playerId);
  const penalty = next.mode === "mercy" ? 6 : 2;
  for (let i = 0; i < penalty; i++) caught.hand.push(takeFromDeck(next));
  next.chat.push(...systemChat(`${caught.name} forgot UNO and drew ${penalty}.`));
  writeRoom(next);
}

function sendChat(text) {
  if (!text.trim()) return;
  const next = structuredClone(state);
  const sender = me();
  next.chat.push({
    id: uid("msg"),
    playerId: clientId,
    name: sender?.name || "Player",
    text: text.trim().slice(0, 240),
    at: Date.now(),
  });
  writeRoom(next);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function render() {
  if (state?.phase === "game") view = "game";
  if (state?.phase === "lobby" && view === "game") view = "lobby";
  app.innerHTML =
    view === "entry" ? entryTemplate() : view === "joining" ? joiningTemplate() : view === "lobby" ? lobbyTemplate() : gameTemplate();
  bindEvents();
  if (eliminationNotice) app.insertAdjacentHTML("beforeend", eliminationTemplate(eliminationNotice));
  const messages = app.querySelector(".messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function entryTemplate() {
  return `
    <section class="entry">
      <div class="brand-lockup">
        <h1>UnoVerse</h1>
        <p>Build a glowing table, invite friends with a room code, and play No Mercy, Flip, or All Wild with chat, UNO calls, eliminations, and animated cards.</p>
        <div class="hero-cards" aria-hidden="true">
          <div class="hero-card red-card" style="--tilt:-14deg;--lift:18px;--delay:0s">7</div>
          <div class="hero-card blue-card" style="--tilt:-4deg;--lift:-2px;--delay:.2s">+2</div>
          <div class="hero-card green-card" style="--tilt:7deg;--lift:20px;--delay:.4s">↺</div>
          <div class="hero-card wild-card" style="--tilt:16deg;--lift:2px;--delay:.6s">W</div>
        </div>
      </div>
      <form class="panel join-panel" id="entryForm">
        <div class="tabs">
          <button type="button" class="${entryMode === "create" ? "active" : ""}" data-entry="create">Create</button>
          <button type="button" class="${entryMode === "join" ? "active" : ""}" data-entry="join">Join</button>
        </div>
        <div class="form-grid">
          <label><span>Name</span><input name="name" maxlength="24" required placeholder="Your table name" /></label>
          <label><span>Gender</span>
            <select name="gender" required>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="nonbinary">Non-binary</option>
              <option value="other">Prefer not to say</option>
            </select>
          </label>
          ${entryMode === "join" ? `<label><span>Room Code</span><input name="code" value="${escapeHtml(roomCode)}" required placeholder="NOVA-UNO-777" /></label>` : ""}
          <button class="primary" type="submit">${entryMode === "create" ? "Create Room" : "Join Room"}</button>
          <p class="small">No login needed. Rooms sync instantly via Firebase — anyone with the code can join from anywhere.</p>
        </div>
      </form>
    </section>
  `;
}

function joiningTemplate() {
  return `
    <section class="entry">
      <div class="brand-lockup">
        <h1>UnoVerse</h1>
        <p>Looking for room ${escapeHtml(roomCode)}. Keep this screen open while UnoVerse connects you to the organizer.</p>
        <div class="hero-cards" aria-hidden="true">
          <div class="hero-card red-card" style="--tilt:-14deg;--lift:18px;--delay:0s">?</div>
          <div class="hero-card blue-card" style="--tilt:-4deg;--lift:-2px;--delay:.2s">?</div>
          <div class="hero-card green-card" style="--tilt:7deg;--lift:20px;--delay:.4s">?</div>
          <div class="hero-card wild-card" style="--tilt:16deg;--lift:2px;--delay:.6s">W</div>
        </div>
      </div>
      <div class="panel join-panel">
        <h2>Joining Room</h2>
        <p class="small">Connecting to Firebase… this should take less than a second. If it fails, check the room code.</p>
        <div class="form-grid">
          <button class="danger" data-action="leave-entry">Back</button>
        </div>
      </div>
    </section>
  `;
}

function lobbyTemplate() {
  const player = me();
  return `
    <section class="lobby">
      ${topbarTemplate()}
      <div class="panel lobby-main">
        <h2>Room Lobby</h2>
        <p class="small">Organizer: ${escapeHtml(state.players.find((p) => p.id === state.hostId)?.name || "Host")}. You are ${escapeHtml(player?.name || "Player")}.</p>
        <div class="mode-grid">
          ${Object.entries(MODES)
            .map(([key, mode]) => `
              <button class="mode ${state.mode === key ? "active" : ""}" data-mode="${key}" ${!isHost() ? "disabled" : ""}>
                <strong>${mode.label}</strong>
                <small>${mode.blurb}</small>
              </button>
            `)
            .join("")}
        </div>
        <h2>Players</h2>
        <div class="players-list">
          ${state.players.map(playerChipTemplate).join("")}
        </div>
      </div>
      ${chatTemplate()}
    </section>
  `;
}

function topbarTemplate() {
  return `
    <header class="panel topbar">
      <div class="mini-brand">UnoVerse</div>
      <div class="room-pill"><span>Room</span><strong>${escapeHtml(roomCode)}</strong></div>
      <div class="hand-actions">
        <button class="ghost" data-action="share">Share Room Code</button>
        <button class="ghost" data-action="audio">${audioOn ? "Mute" : "Sound"}</button>
        ${state?.phase === "lobby" && isHost() ? `<button class="primary" data-action="start">Start Game</button>` : ""}
        ${state?.phase === "game" && isHost() ? `<button class="danger" data-action="end">End Game</button>` : ""}
      </div>
    </header>
  `;
}

function playerChipTemplate(player) {
  return `
    <div class="player-chip">
      <div class="avatar ${player.gender}">${escapeHtml(player.name[0]?.toUpperCase() || "P")}</div>
      <div>
        <strong>${escapeHtml(player.name)} ${player.id === state.hostId ? "• Host" : ""}</strong>
        <div class="small">${player.eliminated ? "Spectating" : `${player.hand?.length || 0} cards`}</div>
      </div>
    </div>
  `;
}

function gameTemplate() {
  const player = me();
  const active = activePlayer();
  const hand = player?.hand || [];
  return `
    <section class="game">
      ${topbarTemplate()}
      <div class="panel table">
        <div class="status-ring"></div>
        <div class="opponents">
          ${state.players
            .filter((candidate) => candidate.id !== clientId)
            .map((candidate) => seatTemplate(candidate, active?.id === candidate.id))
            .join("")}
        </div>
        <div class="center-zone">
          <button class="deck" data-action="draw" title="Draw card"></button>
          <div class="discard">${cardTemplate(topCard(), "glow")}</div>
        </div>
        <div class="hand-zone">
          <div class="hand-actions">
            <button class="uno-btn" data-action="uno">UNO!</button>
            <button class="ghost" data-action="draw">${state.game.drawStack ? `Draw ${state.game.drawStack}` : "Draw"}</button>
            <span class="small">${active?.id === clientId ? "Your turn" : `${escapeHtml(active?.name || "Player")}'s turn`}</span>
          </div>
          <div class="hand">
            ${hand.map((rawCard, index) => cardTemplate(visibleCard(rawCard), canPlay(rawCard, player) ? "playable" : "unplayable", index, rawCard.id)).join("")}
          </div>
        </div>
      </div>
      <aside class="side-panel">
        <div class="panel game-info">
          <h2>${MODES[state.mode].label}</h2>
          <div class="stack-meter">
            <span>Color: <i class="current-color" style="background:${cssColor(state.game.currentColor)}"></i> ${state.game.currentColor}</span>
            <span>Direction: ${state.game.direction === 1 ? "Clockwise" : "Counter-clockwise"}</span>
            <span>Draw stack: ${state.game.drawStack}</span>
            <span>Flip side: ${state.game.currentSide}</span>
          </div>
        </div>
        ${chatTemplate()}
      </aside>
      ${pendingWild ? colorPickerTemplate() : ""}
    </section>
  `;
}

function seatTemplate(player, active) {
  return `
    <div class="seat ${active ? "active" : ""} ${player.eliminated ? "eliminated" : ""}">
      <div class="seat-head">
        <div class="avatar ${player.gender}">${escapeHtml(player.name[0]?.toUpperCase() || "P")}</div>
        <div><strong>${escapeHtml(player.name)}</strong><div class="small">${player.eliminated ? "Spectator" : `${player.hand.length} cards`}</div></div>
      </div>
      <div class="mini-cards">${player.hand.slice(0, 12).map(() => `<span class="mini-card"></span>`).join("")}</div>
      ${player.hand.length === 1 && !player.uno ? `<button class="danger" data-catch="${player.id}">Catch UNO</button>` : ""}
    </div>
  `;
}

function cardTemplate(cardView, extra = "", index = 0, rawId = "") {
  const fan = Math.max(-18, Math.min(18, (index - 3) * 4));
  return `
    <button class="card ${cardView.color} ${cardView.dark ? "dark" : ""} ${extra}" style="--fan:${fan}deg" data-card="${rawId}" ${rawId ? "" : "aria-label='Discard card'"}>
      <span class="corner">${escapeHtml(cardView.label)}</span>
      <span class="face"><span>${escapeHtml(cardView.label)}</span></span>
      <span class="corner-bottom">${escapeHtml(cardView.label)}</span>
    </button>
  `;
}

function colorPickerTemplate() {
  return `
    <div class="color-picker">
      <div class="panel color-box">
        <h2>Choose color</h2>
        <div class="color-buttons">
          ${COLORS.map((color) => `<button style="background:${cssColor(color)}" data-color="${color}">${color}</button>`).join("")}
        </div>
      </div>
    </div>
  `;
}

function chatTemplate() {
  return `
    <section class="panel chat">
      <h2>Table Chat</h2>
      <div class="messages">
        ${(state?.chat || []).slice(-80).map((msg) => `
          <div class="msg"><strong>${escapeHtml(msg.name)}</strong>${escapeHtml(msg.text)}</div>
        `).join("")}
      </div>
      <form class="chat-form">
        <input name="message" maxlength="240" placeholder="Message everyone" />
        <button class="icon-btn" type="submit">Send</button>
      </form>
    </section>
  `;
}

function eliminationTemplate(text) {
  return `
    <div class="elimination">
      <div class="panel elimination-card">
        <span class="cry">😭</span>
        <h2>${escapeHtml(text)}</h2>
        <p class="small">They stay at the table as a spectator and can keep chatting.</p>
      </div>
    </div>
  `;
}

function bindEvents() {
  app.querySelectorAll("[data-entry]").forEach((button) => {
    button.addEventListener("click", () => {
      entryMode = button.dataset.entry;
      render();
    });
  });
  app.querySelector("#entryForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (entryMode === "create") createRoom(data);
    else joinRoom(data);
  });
  app.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = structuredClone(state);
      next.mode = button.dataset.mode;
      writeRoom(next);
    });
  });
  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "start") startGame();
      if (action === "end") endGame();
      if (action === "draw") drawCard();
      if (action === "uno") callUno();
      if (action === "audio") toggleAudio();
      if (action === "share") shareRoom();
      if (action === "leave-entry") {
        view = "entry";
        render();
      }
    });
  });
  app.querySelectorAll("[data-card]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.card) playCard(button.dataset.card);
    });
  });
  app.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => playCard(pendingWild, button.dataset.color));
  });
  app.querySelectorAll("[data-catch]").forEach((button) => {
    button.addEventListener("click", () => catchUno(button.dataset.catch));
  });
  app.querySelector(".chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.message;
    sendChat(input.value);
    input.value = "";
  });
}

async function shareRoom() {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  try {
    if (navigator.share) await navigator.share({ title: "Join my UnoVerse room", text: `Room ${roomCode}`, url });
    else await navigator.clipboard.writeText(`${url}\nRoom code: ${roomCode}`);
    toast("Room link copied.");
  } catch {
    toast(roomCode);
  }
}

function toggleAudio() {
  audioOn = !audioOn;
  localStorage.setItem("unoverse:audio", audioOn ? "on" : "off");
  if (audioOn) playSound("uno");
  render();
}

function playSound(kind) {
  if (!audioOn) return;
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const map = {
    play: [520, 0.08],
    draw: [240, 0.1],
    uno: [760, 0.18],
    wild: [420, 0.2],
    eliminate: [120, 0.32],
    win: [880, 0.32],
    start: [640, 0.2],
  };
  const [freq, duration] = map[kind] || map.play;
  osc.type = kind === "eliminate" ? "sawtooth" : "triangle";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.02);
}

function animatePlayedCard(cardView) {
  const discard = document.querySelector(".discard");
  if (!discard) return;
  const rect = discard.getBoundingClientRect();
  const fly = document.createElement("div");
  fly.className = `card ${cardView.color} fly`;
  fly.style.left = `${window.innerWidth / 2}px`;
  fly.style.top = `${window.innerHeight - 170}px`;
  fly.style.setProperty("--to-x", `${rect.left + 10}px`);
  fly.style.setProperty("--to-y", `${rect.top + 10}px`);
  fly.innerHTML = `<span class="corner">${escapeHtml(cardView.label)}</span><span class="face"><span>${escapeHtml(cardView.label)}</span></span><span class="corner-bottom">${escapeHtml(cardView.label)}</span>`;
  document.body.append(fly);
  setTimeout(() => fly.remove(), 560);
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2400);
}

function cssColor(color) {
  return { red: "#ff3d55", blue: "#27a8ff", green: "#1fd487", yellow: "#ffd83d", wild: "#ffffff" }[color] || "#fff";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function init() {
  try {
    const cfg = firebase.app().options;
    if (!cfg.databaseURL || cfg.databaseURL.includes("YOUR_PROJECT")) {
      toast("Firebase config incomplete — open index.html and fill in your firebaseConfig.");
      render();
      return;
    }
    firebaseDB = firebase.database();
    await firebaseDB.ref(".info/connected").get();
  } catch (err) {
    console.error("Firebase init failed:", err);
    toast("Firebase error: " + (err.message || err.code || "check your config in index.html"));
    render();
    return;
  }
  if (roomCode) connectRoom(roomCode);
  render();
}

init();
