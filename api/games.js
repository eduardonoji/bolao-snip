const { fetchGames } = require('./_games');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const games = await fetchGames();
    return res.status(200).json({ games });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao buscar jogos' });
  }
};
