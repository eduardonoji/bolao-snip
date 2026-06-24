import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // ── SALVAR PALPITE ─────────────────────────────────────────
  if (action === "save" && req.method === "POST") {
    const { nick, pass, gameId, home, away } = req.body;
    const user = await authUser(nick, pass);
    if (!user) return res.status(401).json({ error: "Não autorizado." });
    if (user.status !== "approved") return res.status(403).json({ error: "Conta aguardando aprovação." });

    const key = `palpite:${user.nick}:${gameId}`;
    await kv.set(key, JSON.stringify({ h: parseInt(home), a: parseInt(away), ts: Date.now() }));

    return res.status(200).json({ ok: true });
  }

  // ── BUSCAR PALPITES DO USUÁRIO ─────────────────────────────
  if (action === "my" && req.method === "GET") {
    const { nick, pass } = req.query;
    const user = await authUser(nick, pass);
    if (!user) return res.status(401).json({ error: "Não autorizado." });

    const keys = await kv.keys(`palpite:${user.nick}:*`);
    const palpites = {};
    for (const k of keys) {
      const gameId = k.split(":").slice(2).join(":");
      const val    = await kv.get(k);
      palpites[gameId] = typeof val === "string" ? JSON.parse(val) : val;
    }
    return res.status(200).json({ palpites });
  }

  // ── RANKING GERAL ──────────────────────────────────────────
  if (action === "ranking" && req.method === "GET") {
    const games = await fetchGames();

    const allUsers = await kv.hgetall("users");
    const approved = Object.values(allUsers || {})
      .map(v => (typeof v === "string" ? JSON.parse(v) : v))
      .filter(u => u.status === "approved");

    const ranking = [];
    for (const u of approved) {
      const keys = await kv.keys(`palpite:${u.nick}:*`);
      let pts = 0, count = 0;
      for (const k of keys) {
        const gameId = k.split(":").slice(2).join(":");
        const game   = games.find(g => g.id === gameId);
        if (!game || game.home_score === null || game.away_score === null) continue;
        const val = await kv.get(k);
        const p   = typeof val === "string" ? JSON.parse(val) : val;
        pts += calcPoints(p, game);
        count++;
      }
      ranking.push({ nick: u.nick, pts, count });
    }

    ranking.sort((a, b) => b.pts - a.pts);
    return res.status(200).json({ ranking });
  }

  return res.status(404).json({ error: "Ação não encontrada." });
}

function calcPoints(p, game) {
  const { home_score: hs, away_score: as_ } = game;
  if (p.h === hs && p.a === as_) return 10;
  let pts = 0;
  const rg = hs > as_ ? "H" : hs < as_ ? "A" : "D";
  const rp = p.h > p.a ? "H" : p.h < p.a ? "A" : "D";
  if (rg === rp) pts += 5;
  if (p.h === hs || p.a === as_) pts += 2;
  return pts;
}

async function authUser(nick, pass) {
  const slug = (nick || "").trim().toLowerCase();
  const raw  = await kv.hget("users", slug);
  if (!raw) return null;
  const user = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (user.pass !== Buffer.from(pass || "").toString("base64")) return null;
  return user;
}

async function fetchGames() {
  try {
    const cached = await kv.get("games_cache");
    if (cached) {
      const { data, ts } = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (Date.now() - ts < 60_000) return data;
    }
    const r    = await fetch("https://worldcup26.ir/get/games");
    const json = await r.json();
    const games = (json.games || json || []).map(g => ({
      id: g.id || `${g.home}_${g.away}`,
      home: g.home_team || g.home || "",
      away: g.away_team || g.away || "",
      home_score: g.home_score !== undefined ? g.home_score : (g.score?.home_team ?? null),
      away_score: g.away_score !== undefined ? g.away_score : (g.score?.away_team ?? null),
      status: g.status || "scheduled",
      datetime: g.datetime || g.date || "",
    }));
    await kv.set("games_cache", JSON.stringify({ data: games, ts: Date.now() }), { ex: 120 });
    return games;
  } catch {
    return [];
  }
}
