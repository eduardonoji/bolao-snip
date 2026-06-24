const { neon } = require('@neondatabase/serverless');
const { fetchGames } = require('./_games');

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

function calcPoints(p, game) {
  if (game.homeScore === null || game.awayScore === null) return 0;
  const ph = p.h, pa = p.a, gh = game.homeScore, ga = game.awayScore;
  if (ph === gh && pa === ga) return 10;
  const pResult = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
  const gResult = gh > ga ? 'H' : gh < ga ? 'A' : 'D';
  if (pResult === gResult) return 5;
  if (ph === gh || pa === ga) return 2;
  return 0;
}

function calcReason(p, game) {
  if (game.status === 'scheduled') return 'aguardando';
  if (game.homeScore === null || game.awayScore === null) return 'aguardando';
  const ph = p.h, pa = p.a, gh = game.homeScore, ga = game.awayScore;
  if (ph === gh && pa === ga) return 'exato';
  const pResult = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
  const gResult = gh > ga ? 'H' : gh < ga ? 'A' : 'D';
  if (pResult === gResult) return 'resultado';
  if (ph === gh || pa === ga) return 'gol';
  return 'errou';
}

async function verifyUser(nick, pass) {
  const sql = neon(process.env.DATABASE_URL);
  const encoded = Buffer.from(pass).toString('base64');
  const rows = await sql`SELECT nick, status, role FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
  return rows.length ? rows[0] : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    const sql = await getDb();

    if (req.method === 'POST' && action === 'save') {
      const { nick, pass, gameId, home, away } = req.body;
      if (!nick || !pass || !gameId || home === undefined || away === undefined) {
        return res.status(400).json({ error: 'Dados incompletos' });
      }
      const user = await verifyUser(nick, pass);
      if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
      if (user.status !== 'approved') return res.status(403).json({ error: 'Usuário não aprovado' });

      const games = await fetchGames();
      const game = games.find(g => g.id === gameId);
      if (!game) return res.status(404).json({ error: 'Jogo não encontrado' });
      const gameStarted = game.status !== 'scheduled' || (game.datetime && new Date() >= new Date(game.datetime));
      if (gameStarted) return res.status(403).json({ error: 'Jogo já iniciado — palpite bloqueado' });

      await sql`
        INSERT INTO palpites (nick, game_id, home_score, away_score)
        VALUES (${nick}, ${gameId}, ${parseInt(home)}, ${parseInt(away)})
        ON CONFLICT (nick, game_id) DO UPDATE
          SET home_score = EXCLUDED.home_score,
              away_score = EXCLUDED.away_score,
              created_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && action === 'my') {
      const { nick, pass } = req.query;
      const user = await verifyUser(nick, pass);
      if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
      if (user.status !== 'approved') return res.status(403).json({ error: 'Usuário não aprovado' });

      const rows = await sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${nick}`;
      const palpites = {};
      for (const r of rows) {
        palpites[r.game_id] = { h: r.home_score, a: r.away_score };
      }
      return res.status(200).json({ palpites });
    }

    if (req.method === 'GET' && action === 'ranking') {
      let finishedOrLive = [];
      try {
        const games = await fetchGames();
        finishedOrLive = games.filter(g => g.status === 'completed' || g.status === 'in_progress');
      } catch (_) {}

      const users = await sql`SELECT nick FROM users WHERE status = 'approved'`;
      const allPalpites = await sql`SELECT nick, game_id, home_score, away_score FROM palpites`;

      const byNick = {};
      for (const p of allPalpites) {
        if (!byNick[p.nick]) byNick[p.nick] = {};
        byNick[p.nick][p.game_id] = { h: p.home_score, a: p.away_score };
      }

      const ranking = users.map(u => {
        const mine = byNick[u.nick] || {};
        let pts = 0, count = 0;
        for (const g of finishedOrLive) {
          const p = mine[g.id];
          if (p) {
            const earned = calcPoints(p, g);
            pts += earned;
            if (earned > 0) count++;
          }
        }
        return { nick: u.nick, pts, count };
      }).sort((a, b) => b.pts - a.pts || b.count - a.count || a.nick.localeCompare(b.nick));

      return res.status(200).json({ ranking });
    }

    if (req.method === 'GET' && action === 'profile') {
      const { nick: targetNick } = req.query;
      if (!targetNick) return res.status(400).json({ error: 'nick obrigatório' });

      let games = [];
      try {
        games = await fetchGames();
      } catch (_) {}
      const gameMap = {};
      for (const g of games) gameMap[g.id] = g;

      const rows = await sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${targetNick} ORDER BY created_at`;

      const bets = [];
      let totalPts = 0;
      for (const r of rows) {
        const game = gameMap[r.game_id];
        if (!game) continue;
        const p = { h: r.home_score, a: r.away_score };
        const pts = calcPoints(p, game);
        const reason = calcReason(p, game);
        if (game.status !== 'scheduled') totalPts += pts;
        bets.push({
          gameId: r.game_id,
          home: game.home,
          away: game.away,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          status: game.status,
          datetime: game.datetime,
          group: game.group,
          palpiteH: r.home_score,
          palpiteA: r.away_score,
          pts,
          reason,
        });
      }

      bets.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

      return res.status(200).json({ nick: targetNick, totalPts, bets });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
