module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { home, away } = req.body || {};
  if (!home || !away) return res.status(400).json({ error: 'Times inválidos' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error: 'Serviço de IA não configurado. Adicione GROQ_API_KEY nas variáveis de ambiente.' });

  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Você é um analista esportivo especializado em futebol. Responda sempre em JSON com os campos "home" e "away" (números inteiros, sem negativos).'
          },
          {
            role: 'user',
            content: `Preveja o placar mais provável para a partida da Copa do Mundo 2026 entre ${home} (mandante) e ${away} (visitante). Considere o histórico e a força dos times. Retorne apenas JSON: {"home": <gols>, "away": <gols>}`
          }
        ],
        temperature: 0.7,
        max_tokens: 50
      })
    });
  } catch (e) {
    return res.status(502).json({ error: 'Erro ao conectar com a IA.' });
  }

  if (!r.ok) {
    return res.status(502).json({ error: 'Erro na IA (código ' + r.status + ').' });
  }

  let data;
  try {
    data = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Resposta inválida da IA.' });
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) return res.status(502).json({ error: 'A IA não retornou um placar.' });

  let scores;
  try {
    scores = JSON.parse(text);
  } catch (e) {
    return res.status(502).json({ error: 'Formato de resposta da IA inválido.' });
  }

  const homeScore = parseInt(scores.home);
  const awayScore = parseInt(scores.away);
  if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
    return res.status(502).json({ error: 'Placar da IA fora do esperado.' });
  }

  res.json({ home: homeScore, away: awayScore });
};
