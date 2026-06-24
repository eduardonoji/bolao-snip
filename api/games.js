module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const r = await fetch("https://worldcup26.ir/get/games");
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
    return res.status(200).json({ games });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao buscar jogos.", detail: e.message });
  }
};
