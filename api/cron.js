const { neon } = require('@neondatabase/serverless');
const { fetchGames } = require('./_games');
const { sendEmail } = require('./_email');

function getWindowBoundsUTC() {
  const now = new Date();
  const manausNow = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const h = manausNow.getUTCHours();
  const start = new Date(manausNow);
  start.setUTCHours(10, 0, 0, 0);
  if (h < 6) start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function buildReminderEmail(nick, triggerGame, otherMissingGames) {
  const fmtTime = (dt) =>
    new Date(dt).toLocaleTimeString('pt-BR', { timeZone: 'America/Manaus', hour: '2-digit', minute: '2-digit' });

  const triggerRow = `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #333;font-size:14px;color:#f0f0f0">
        ⚽ <strong>${triggerGame.home} × ${triggerGame.away}</strong>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #333;font-size:14px;color:#fcd34d;text-align:right;white-space:nowrap">
        ${fmtTime(triggerGame.datetime)} ⏰
      </td>
    </tr>`;

  const otherRows = otherMissingGames.map(g => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #2a2a2a;font-size:13px;color:#ccc">${g.home} × ${g.away}</td>
      <td style="padding:8px 0;border-bottom:1px solid #2a2a2a;font-size:13px;color:#999;text-align:right;white-space:nowrap">${fmtTime(g.datetime)}</td>
    </tr>`).join('');

  const otherSection = otherMissingGames.length ? `
    <p style="margin:20px 0 8px;font-size:13px;color:#999;font-weight:600">
      Você também ainda não apostou nesses jogos de hoje:
    </p>
    <table style="width:100%;border-collapse:collapse">${otherRows}</table>` : '';

  const appUrl = process.env.APP_URL || 'https://bolao-snip.vercel.app';
  const totalJogos = 1 + otherMissingGames.length;
  return {
    subject: `⚽ Bolão Snip – Aposte nos jogos de hoje, ${nick}!`,
    html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f0f0f">
  <div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="margin-bottom:24px">
      <span style="font-size:28px">⚽</span>
      <span style="font-size:18px;font-weight:700;color:#f0f0f0;margin-left:8px">Bolão Snip - 2026</span>
    </div>
    <div style="background:#1a1a1a;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08)">
      <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#f0f0f0">Opa, ${nick}! 👋</p>
      <p style="margin:0 0 16px;font-size:14px;color:#999;line-height:1.5">
        Hoje tem <strong style="color:#f0f0f0">${totalJogos} jogo${totalJogos > 1 ? 's' : ''}</strong> e você ainda não fez ${totalJogos > 1 ? 'seus palpites' : 'seu palpite'}. Não perca pontos!
      </p>
      <table style="width:100%;border-collapse:collapse">${triggerRow}</table>
      ${otherSection}
      <div style="margin-top:24px;text-align:center">
        <a href="${appUrl}"
           style="display:inline-block;background:#3b82f6;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
          Apostar agora
        </a>
      </div>
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#555;text-align:center">
      Você recebe este e-mail porque tem uma conta no Bolão Snip.
    </p>
  </div>
</body>
</html>`,
  };
}

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Tabela de lembretes enviados (evita duplicatas)
    await sql`
      CREATE TABLE IF NOT EXISTS reminders (
        nick TEXT NOT NULL,
        game_id TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (nick, game_id)
      )
    `;

    const { start, end } = getWindowBoundsUTC();
    const games = await fetchGames();

    // Jogos de hoje ainda agendados
    const todayScheduled = games.filter(g => {
      if (!g.datetime || g.status !== 'scheduled') return false;
      const d = new Date(g.datetime);
      return d >= start && d < end;
    });

    if (!todayScheduled.length) {
      return res.status(200).json({ ok: true, message: 'Nenhum jogo agendado hoje.' });
    }

    // Primeiro jogo do dia como "trigger" do lembrete
    todayScheduled.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    const triggerGame = todayScheduled[0];

    const users = await sql`SELECT nick, email FROM users WHERE status = 'approved' AND email IS NOT NULL AND email != '' AND email_reminders IS NOT FALSE`;
    if (!users.length) {
      return res.status(200).json({ ok: true, message: 'Nenhum usuário com e-mail.' });
    }

    const allGameIds = todayScheduled.map(g => g.id);
    const palpites = await sql`SELECT nick, game_id FROM palpites WHERE game_id = ANY(${allGameIds})`;
    const betSet = new Set(palpites.map(p => `${p.nick}:${p.game_id}`));

    // Usa o trigger game para rastrear se o lembrete diário já foi enviado
    const sentReminders = await sql`SELECT nick FROM reminders WHERE game_id = ${triggerGame.id}`;
    const sentSet = new Set(sentReminders.map(r => r.nick));

    let sent = 0;
    for (const user of users) {
      // Já recebeu lembrete hoje
      if (sentSet.has(user.nick)) continue;

      // Jogos sem palpite
      const missing = todayScheduled.filter(g => !betSet.has(`${user.nick}:${g.id}`));
      if (!missing.length) continue;

      const firstMissing = missing[0];
      const otherMissing = missing.slice(1);

      const { subject, html } = buildReminderEmail(user.nick, firstMissing, otherMissing);
      const ok = await sendEmail(user.email, subject, html);
      if (ok) {
        await sql`INSERT INTO reminders (nick, game_id) VALUES (${user.nick}, ${triggerGame.id}) ON CONFLICT DO NOTHING`;
        sent++;
      }
    }

    return res.status(200).json({ ok: true, sent, users: users.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro no cron' });
  }
};
