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
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE`.catch(() => {});
  return sql;
}

function calcPoints(p, game, pts = { exact: 10, result: 5, goal: 2 }) {
  if (game.homeScore === null || game.awayScore === null) return 0;
  const ph = p.h, pa = p.a, gh = game.homeScore, ga = game.awayScore;
  if (ph === gh && pa === ga) return pts.exact;
  const pResult = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
  const gResult = gh > ga ? 'H' : gh < ga ? 'A' : 'D';
  if (pResult === gResult) return pts.result;
  if (ph === gh || pa === ga) return pts.goal;
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

function ptsFromSettings(map) {
  return {
    exact:  parseInt(map.pts_exact  || '10') || 10,
    result: parseInt(map.pts_result || '5')  || 5,
    goal:   parseInt(map.pts_goal   || '2')  || 2,
  };
}

async function verifyUser(nick, pass) {
  const sql = neon(process.env.DATABASE_URL);
  const encoded = Buffer.from(pass).toString('base64');
  const rows = await sql`SELECT nick, status, role, paid FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
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
      } catch (_) {
        return res.status(503).json({ error: 'Falha ao buscar jogos. Tente novamente.' });
      }

      const [users, allPalpites, settingsRows, paidCountRows] = await Promise.all([
        sql`SELECT nick, avatar FROM users WHERE status = 'approved'`,
        sql`SELECT nick, game_id, home_score, away_score FROM palpites`,
        sql`SELECT key, value FROM settings`,
        sql`SELECT COUNT(*) as count FROM users WHERE paid = true AND status = 'approved'`,
      ]);

      const settingsMap = {};
      for (const r of settingsRows) settingsMap[r.key] = r.value;
      const entryValue = parseFloat(settingsMap.entry_value || '0') || 0;
      const prize = settingsMap.payment_mode === 'fixed_prize'
        ? (parseFloat(settingsMap.prize_value) || 0)
        : (parseInt(paidCountRows[0].count) || 0) * entryValue;
      const pts = ptsFromSettings(settingsMap);

      const byNick = {};
      for (const p of allPalpites) {
        if (!byNick[p.nick]) byNick[p.nick] = {};
        byNick[p.nick][p.game_id] = { h: p.home_score, a: p.away_score };
      }

      const ranking = users.map(u => {
        const mine = byNick[u.nick] || {};
        let score = 0, count = 0;
        for (const g of finishedOrLive) {
          const p = mine[g.id];
          if (p) {
            const earned = calcPoints(p, g, pts);
            score += earned;
            if (earned > 0) count++;
          }
        }
        return { nick: u.nick, pts: score, count, avatar: u.avatar || null };
      }).sort((a, b) => b.pts - a.pts || b.count - a.count || a.nick.localeCompare(b.nick));

      return res.status(200).json({ ranking, prize });
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

      const [rows, profileSettings] = await Promise.all([
        sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${targetNick} ORDER BY created_at`,
        sql`SELECT key, value FROM settings`,
      ]);
      const profileSettingsMap = {};
      for (const r of profileSettings) profileSettingsMap[r.key] = r.value;
      const profilePts = ptsFromSettings(profileSettingsMap);

      const bets = [];
      let totalPts = 0;
      for (const r of rows) {
        const game = gameMap[r.game_id];
        if (!game) continue;
        const p = { h: r.home_score, a: r.away_score };
        const pts = calcPoints(p, game, profilePts);
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

    if (req.method === 'GET' && action === 'insights') {
      const { nick, pass } = req.query;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const user = await verifyUser(nick, pass);
      if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Não autorizado' });

      let games = [];
      try { games = await fetchGames(); } catch (_) {}

      const [rows, insightsSettings] = await Promise.all([
        sql`SELECT game_id, home_score, away_score FROM palpites WHERE nick = ${nick}`,
        sql`SELECT key, value FROM settings`,
      ]);
      const insightsSettingsMap = {};
      for (const r of insightsSettings) insightsSettingsMap[r.key] = r.value;
      const insightsPts = ptsFromSettings(insightsSettingsMap);
      const pMap = {};
      for (const r of rows) pMap[r.game_id] = { h: r.home_score, a: r.away_score };

      const now = new Date();
      const manausNow = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      const h = manausNow.getUTCHours();
      const todayStart = new Date(manausNow);
      todayStart.setUTCHours(10, 0, 0, 0);
      if (h < 6) todayStart.setUTCDate(todayStart.getUTCDate() - 1);
      const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

      const completed = games.filter(g => g.status === 'completed');
      const yesterday = completed.filter(g => {
        const d = new Date(g.datetime);
        return d >= yStart && d < todayStart;
      });

      function summarize(gameList) {
        let pts = 0, exact = 0, result = 0, goal = 0, miss = 0, total = 0;
        for (const g of gameList) {
          const p = pMap[g.id];
          if (!p) continue;
          total++;
          const reason = calcReason(p, g);
          pts += calcPoints(p, g, insightsPts);
          if (reason === 'exato') exact++;
          else if (reason === 'resultado') result++;
          else if (reason === 'gol') goal++;
          else if (reason === 'errou') miss++;
        }
        const hitRate = total > 0 ? Math.round((exact + result + goal) / total * 100) : null;
        return { pts, exact, result, goal, miss, total, hitRate };
      }

      return res.status(200).json({ total: summarize(completed), yesterday: summarize(yesterday) });
    }

    if (req.method === 'GET' && action === 'settings') {
      const rows = await sql`SELECT key, value FROM settings`;
      const s = {};
      for (const r of rows) s[r.key] = r.value;
      return res.status(200).json({ settings: s });
    }

    if (req.method === 'POST' && action === 'save-settings') {
      const { adminNick, adminPass, pixKey, pixKeyType, pixName, pixCity, entryValue, ptsExact, ptsResult, ptsGoal, paymentMode, prizeValue } = req.body;
      const admin = await verifyUser(adminNick, adminPass);
      if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      const entries = [
        ['pix_key', pixKey || ''],
        ['pix_key_type', pixKeyType || 'chave_aleatoria'],
        ['pix_name', pixName || ''],
        ['pix_city', pixCity || ''],
        ['entry_value', String(parseFloat(entryValue) || 0)],
        ['pts_exact',  String(parseInt(ptsExact)  || 10)],
        ['pts_result', String(parseInt(ptsResult) || 5)],
        ['pts_goal',   String(parseInt(ptsGoal)   || 2)],
        ['payment_mode', paymentMode === 'fixed_prize' ? 'fixed_prize' : 'per_person'],
        ['prize_value', String(parseFloat(prizeValue) || 0)],
      ];
      for (const [key, value] of entries) {
        await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'reset-scores') {
      const { adminNick, adminPass } = req.body;
      const admin = await verifyUser(adminNick, adminPass);
      if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      await sql`DELETE FROM palpites`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'mark-paid') {
      const { adminNick, adminPass, targetNick, paid } = req.body;
      const admin = await verifyUser(adminNick, adminPass);
      if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      await sql`UPDATE users SET paid = ${paid === true} WHERE nick = ${targetNick}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
