const { neon } = require("@neondatabase/serverless");

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS palpites (
      id SERIAL PRIMARY KEY,
      nick TEXT NOT NULL,
      game_id TEXT NOT NULL,
      home_score INT NOT NULL,
      away_score INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(nick, game_id)
    )
  `;
  return sql;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;
  const sql = await getDb();

  if (action === "save" && req.method === "POST") {
    const { nick, pass, gameId, home, away } = req.body;
    const user = await authUser(sql, nick, pass);
    if (!user) return res.status(401).json({ error: "Não autorizado." });
    if (user.status !== "approved") return res.status(403).json({ error: "Conta aguardando aprovação." });

    await sql`
      INSERT INTO palpites (nick, game_id, home_score, away_score)
      VALUES (${user.nick}, ${gameId}, ${parseInt(home)}, ${parseInt(away)})
      ON CONFLICT (nick, game_id) DO UPDATE SET home_score = ${parseInt(home)}, away_score = ${parseInt(away)}
    `;
    return res.status(200).json({ ok: true });
  }

  if (action === "my" && req.method === "GET") {
    const { nick, pass } = req.query;
    const user = await authUser(sql, nick, pass);
    if (!user) return res.status(401).json({ error: "Não autorizado." });

    const rows = await sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${user.nick}`;
    const palpites = {};
    rows.forEach(r => { palpites[r.game_id] = { h: r.home_score, a: r.away_score }; });
    return res.status(200).json({ palpites });
  }

  if (action === "ranking" && req.method === "GET") {
    const games = await fetchGames();
    const allUsers = await sql`SELECT nick FROM users WHERE status = 'approved'`;
    const ranking = [];

    for (const u of allUsers) {
      const rows = await sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${u.nick}`;
      let pts = 0, count = 0;
      for (const r of rows) {
        const game = games.find(g => g.id === r.game_id);
        if (!game || game.home_score === null || game.away_score === null) continue;
        pts += calcPoints({ h: r.home_score, a: r.away_score }, game);
        count++;
      }
      ranking.push({ nick: u.nick, pts, count });
    }

    ranking.sort((a, b) => b.pts - a.pts);
    return res.status(200).json({ ranking });
  }

  return res.status(404).json({ error: "Ação não encontrada." });
};

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

async function authUser(sql, nick, pass) {
  const slug = (nick || "").trim().toLowerCase();
  const rows = await sql`SELECT * FROM users WHERE nick = ${slug}`;
  if (rows.length === 0) return null;
  const user = rows[0];
  if (user.pass !== Buffer.from(pass || "").toString("base64")) return null;
  return user;
}

async function fetchGames() {
  try {
    const r = await fetch("https://worldcup26.ir/get/games");
    const json = await r.json();
    return (json.games || json || []).map(g => ({
      id: g.id || `${g.home}_${g.away}`,
      home: g.home_team || g.home || "",
      away: g.away_team || g.away || "",
      home_score: g.home_score !== undefined ? g.home_score : (g.score?.home_team ?? null),
      away_score: g.away_score !== undefined ? g.away_score : (g.score?.away_team ?? null),
      status: g.status || "scheduled",
      datetime: g.datetime || g.date || "",
    }));
  } catch {
    return [];
  }
}
