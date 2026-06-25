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
  return {
    subject: `⚽ Bolão Snip – Falta menos de 1h! ${triggerGame.home} × ${triggerGame.away}`,
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
        Falta menos de 1 hora para o jogo começar e você ainda não apostou:
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

    // Jogos que começam em 50–80 min (janela de lembrete)
    const now = Date.now();
    const REMIND_MIN_MS = 50 * 60 * 1000;
    const REMIND_MAX_MS = 80 * 60 * 1000;
    const triggerGames = todayScheduled.filter(g => {
      const ms = new Date(g.datetime).getTime() - now;
      return ms >= REMIND_MIN_MS && ms < REMIND_MAX_MS;
    });

    if (!triggerGames.length) {
      return res.status(200).json({ ok: true, message: 'Nenhum jogo na janela de lembrete agora.' });
    }

    const users = await sql`SELECT nick, email FROM users WHERE status = 'approved' AND email IS NOT NULL AND email != '' AND email_reminders IS NOT FALSE`;
    if (!users.length) {
      return res.status(200).json({ ok: true, message: 'Nenhum usuário com e-mail.' });
    }

    const allGameIds = todayScheduled.map(g => g.id);
    const palpites = await sql`SELECT nick, game_id FROM palpites WHERE game_id = ANY(${allGameIds})`;
    const betSet = new Set(palpites.map(p => `${p.nick}:${p.game_id}`));

    const triggerIds = triggerGames.map(g => g.id);
    const sentReminders = await sql`SELECT nick, game_id FROM reminders WHERE game_id = ANY(${triggerIds})`;
    const sentSet = new Set(sentReminders.map(r => `${r.nick}:${r.game_id}`));

    let sent = 0;
    for (const user of users) {
      for (const triggerGame of triggerGames) {
        const key = `${user.nick}:${triggerGame.id}`;
        // Já apostou neste jogo ou já recebeu lembrete para ele — pula
        if (betSet.has(key) || sentSet.has(key)) continue;

        // Outros jogos de hoje sem palpite (excluindo o trigger)
        const otherMissing = todayScheduled.filter(g =>
          g.id !== triggerGame.id && !betSet.has(`${user.nick}:${g.id}`)
        );

        const { subject, html } = buildReminderEmail(user.nick, triggerGame, otherMissing);
        const ok = await sendEmail(user.email, subject, html);
        if (ok) {
          await sql`INSERT INTO reminders (nick, game_id) VALUES (${user.nick}, ${triggerGame.id}) ON CONFLICT DO NOTHING`;
          sent++;
        }
      }
    }

    return res.status(200).json({ ok: true, sent, users: users.length, triggerGames: triggerGames.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro no cron' });
  }
};
