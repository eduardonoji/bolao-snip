const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { sendEmail } = require('./_email');

const ADMIN_NICK = 'eduardo';
const APP_URL = process.env.APP_URL || 'https://bolao-snip.vercel.app';

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      nick TEXT PRIMARY KEY,
      pass TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await Promise.all([
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_token TEXT`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_reminders BOOLEAN DEFAULT TRUE`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`.catch(() => {}),
  ]);
  return sql;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    const sql = await getDb();

    if (req.method === 'POST' && action === 'register') {
      const { nick, pass, email } = req.body;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const encoded = Buffer.from(pass).toString('base64');
      const isAdmin = nick === ADMIN_NICK;
      const status = isAdmin ? 'approved' : 'pending';
      const role = isAdmin ? 'admin' : 'user';
      const emailVal = email && email.includes('@') ? email.trim().toLowerCase() : null;
      const approvalToken = isAdmin ? null : crypto.randomUUID();
      try {
        await sql`INSERT INTO users (nick, pass, email, status, role, approval_token) VALUES (${nick}, ${encoded}, ${emailVal}, ${status}, ${role}, ${approvalToken})`;
      } catch (e) {
        if (e.message && e.message.includes('duplicate')) {
          return res.status(409).json({ error: 'Nick já em uso' });
        }
        throw e;
      }

      // Notificar admin sobre novo cadastro
      if (!isAdmin && approvalToken) {
        const adminRows = await sql`SELECT email FROM users WHERE nick = ${ADMIN_NICK}`;
        const adminEmail = adminRows[0]?.email || process.env.ADMIN_EMAIL;
        if (adminEmail) {
          const approveUrl = `${APP_URL}/api/auth?action=quick-approve&nick=${encodeURIComponent(nick)}&token=${encodeURIComponent(approvalToken)}`;
          await sendEmail(adminEmail, `🔔 Bolão Snip — Novo cadastro: ${nick}`, buildAdminNotifEmail(nick, emailVal, approveUrl));
        }
      }

      return res.status(200).json({ nick, status, role });
    }

    if (req.method === 'POST' && action === 'login') {
      const { nick, pass } = req.body;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const encoded = Buffer.from(pass).toString('base64');
      const rows = await sql`SELECT nick, status, role, email, email_reminders, paid, avatar FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
      if (!rows.length) return res.status(401).json({ error: 'Nick ou senha incorretos' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'POST' && action === 'update-profile') {
      const { nick, pass, newNick, newEmail, newPass, emailReminders } = req.body;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const encoded = Buffer.from(pass).toString('base64');
      const rows = await sql`SELECT nick FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
      if (!rows.length) return res.status(401).json({ error: 'Senha atual incorreta' });

      const finalNick = (newNick && newNick.trim().length >= 2) ? newNick.trim() : nick;
      const finalEmail = newEmail && newEmail.includes('@') ? newEmail.trim().toLowerCase() : null;
      const finalReminders = emailReminders !== false;

      if (finalNick !== nick) {
        const conflict = await sql`SELECT 1 FROM users WHERE nick = ${finalNick}`;
        if (conflict.length) return res.status(409).json({ error: 'Nick já em uso' });
        await sql`UPDATE palpites SET nick = ${finalNick} WHERE nick = ${nick}`;
        await sql`UPDATE reminders SET nick = ${finalNick} WHERE nick = ${nick}`.catch(() => {});
      }

      if (newPass) {
        const newEncoded = Buffer.from(newPass).toString('base64');
        await sql`UPDATE users SET nick = ${finalNick}, email = ${finalEmail}, pass = ${newEncoded}, email_reminders = ${finalReminders} WHERE nick = ${nick}`;
      } else {
        await sql`UPDATE users SET nick = ${finalNick}, email = ${finalEmail}, email_reminders = ${finalReminders} WHERE nick = ${nick}`;
      }

      return res.status(200).json({ ok: true, nick: finalNick, email: finalEmail, email_reminders: finalReminders });
    }

    // Verificar status atual (polling na tela pendente)
    if (req.method === 'GET' && action === 'status') {
      const { nick, pass } = req.query;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const encoded = Buffer.from(pass).toString('base64');
      const rows = await sql`SELECT status, role, paid FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
      if (!rows.length) return res.status(401).json({ error: 'Credenciais inválidas' });
      return res.status(200).json(rows[0]);
    }

    // Aprovação rápida via link do e-mail
    if (req.method === 'GET' && action === 'quick-approve') {
      const { nick, token } = req.query;
      if (!nick || !token) return res.status(400).send(htmlPage('Parâmetros inválidos', 'Link malformado.'));
      const rows = await sql`SELECT approval_token, status, email FROM users WHERE nick = ${nick}`;
      if (!rows.length) return res.status(404).send(htmlPage('Não encontrado', 'Usuário não encontrado.'));
      if (rows[0].status === 'approved') {
        return res.status(200).send(htmlPage('✅ Já aprovado', `${nick} já estava aprovado.`));
      }
      if (rows[0].approval_token !== token) {
        return res.status(403).send(htmlPage('Link inválido', 'Este link já foi utilizado ou é inválido.'));
      }
      await sql`UPDATE users SET status = 'approved', paid = true, approval_token = NULL WHERE nick = ${nick}`;
      if (rows[0].email) {
        await sendEmail(rows[0].email, '✅ Bolão Snip — Você foi aprovado!', buildApprovedEmail(nick));
      }
      return res.status(200).send(htmlPage('🎉 Aprovado!', `${nick} foi aprovado e já pode participar do bolão.`));
    }

    if (req.method === 'GET' && action === 'pending') {
      const { adminNick, adminPass } = req.query;
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      const rows = await sql`SELECT nick, email, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at`;
      return res.status(200).json({ users: rows });
    }

    if (req.method === 'GET' && action === 'all') {
      const { adminNick, adminPass } = req.query;
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      const rows = await sql`SELECT nick, email, status, role, paid, avatar, created_at FROM users ORDER BY created_at`;
      return res.status(200).json({ users: rows });
    }

    if (req.method === 'POST' && action === 'approve') {
      const { adminNick, adminPass, targetNick, decision } = req.body;
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      if (decision === 'approve') {
        await sql`UPDATE users SET status = 'approved', paid = true WHERE nick = ${targetNick}`;
      } else {
        await sql`UPDATE users SET status = 'rejected' WHERE nick = ${targetNick}`;
      }
      if (decision === 'approve') {
        const userRows = await sql`SELECT email FROM users WHERE nick = ${targetNick}`;
        if (userRows[0]?.email) {
          await sendEmail(userRows[0].email, '✅ Bolão Snip — Você foi aprovado!', buildApprovedEmail(targetNick));
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'reset-password') {
      const { adminNick, adminPass, targetNick, newPass } = req.body;
      if (!targetNick || !newPass) return res.status(400).json({ error: 'targetNick e newPass obrigatórios' });
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      if (targetNick === ADMIN_NICK) return res.status(400).json({ error: 'Não é possível resetar a senha do admin' });
      const targetRows = await sql`SELECT 1 FROM users WHERE nick = ${targetNick}`;
      if (!targetRows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
      const newEncoded = Buffer.from(newPass).toString('base64');
      await sql`UPDATE users SET pass = ${newEncoded} WHERE nick = ${targetNick}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'revoke') {
      const { adminNick, adminPass, targetNick } = req.body;
      if (!targetNick) return res.status(400).json({ error: 'targetNick obrigatório' });
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      if (targetNick === ADMIN_NICK) return res.status(400).json({ error: 'Não é possível revogar o admin' });
      await sql`UPDATE users SET status = 'pending', paid = false WHERE nick = ${targetNick}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'admin-edit-user') {
      const { adminNick, adminPass, targetNick, newNick, newEmail, newPass, removeAvatar } = req.body;
      if (!targetNick) return res.status(400).json({ error: 'targetNick obrigatório' });
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      if (removeAvatar) {
        await sql`UPDATE users SET avatar = NULL WHERE nick = ${targetNick}`;
        return res.status(200).json({ ok: true });
      }
      const finalNick = newNick && newNick.trim().length >= 2 ? newNick.trim() : targetNick;
      const finalEmail = newEmail && newEmail.includes('@') ? newEmail.trim().toLowerCase() : null;
      if (finalNick !== targetNick) {
        const conflict = await sql`SELECT 1 FROM users WHERE nick = ${finalNick}`;
        if (conflict.length) return res.status(409).json({ error: 'Nick já em uso' });
        await sql`UPDATE palpites SET nick = ${finalNick} WHERE nick = ${targetNick}`;
      }
      if (newPass && newPass.trim().length >= 4) {
        const newEncoded = Buffer.from(newPass.trim()).toString('base64');
        await sql`UPDATE users SET nick = ${finalNick}, email = ${finalEmail}, pass = ${newEncoded} WHERE nick = ${targetNick}`;
      } else {
        await sql`UPDATE users SET nick = ${finalNick}, email = ${finalEmail} WHERE nick = ${targetNick}`;
      }
      return res.status(200).json({ ok: true, newNick: finalNick });
    }

    if (req.method === 'POST' && action === 'delete') {
      const { adminNick, adminPass, targetNick } = req.body;
      if (!targetNick) return res.status(400).json({ error: 'targetNick obrigatório' });
      const encoded = Buffer.from(adminPass || '').toString('base64');
      const adminRows = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND pass = ${encoded}`;
      if (!adminRows.length || adminRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      if (targetNick === ADMIN_NICK) {
        return res.status(400).json({ error: 'Não é possível excluir o admin' });
      }
      await sql`DELETE FROM palpites WHERE nick = ${targetNick}`;
      await sql`DELETE FROM users WHERE nick = ${targetNick}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'save-avatar') {
      const { nick, pass, avatar } = req.body;
      if (!nick || !pass) return res.status(400).json({ error: 'nick e pass obrigatórios' });
      const encoded = Buffer.from(pass).toString('base64');
      const rows = await sql`SELECT nick FROM users WHERE nick = ${nick} AND pass = ${encoded}`;
      if (!rows.length) return res.status(401).json({ error: 'Credenciais inválidas' });
      if (avatar && avatar.length > 40000) return res.status(400).json({ error: 'Imagem muito grande. Tente uma foto menor.' });
      await sql`UPDATE users SET avatar = ${avatar || null} WHERE nick = ${nick}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Bolão Snip</title></head>
<body style="background:#0f0f0f;color:#f0f0f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px">
  <div>
    <h2 style="margin:0 0 8px;font-size:22px">${title}</h2>
    <p style="color:#999;font-size:14px;margin:0 0 24px">${message}</p>
    <a href="${APP_URL}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">Ir para o bolão</a>
  </div>
</body>
</html>`;
}

function buildAdminNotifEmail(nick, email, approveUrl) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f0f0f">
  <div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="margin-bottom:24px">
      <span style="font-size:28px">⚽</span>
      <span style="font-size:18px;font-weight:700;color:#f0f0f0;margin-left:8px">Bolão Snip - 2026</span>
    </div>
    <div style="background:#1a1a1a;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08)">
      <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#f0f0f0">Novo cadastro 🔔</p>
      <p style="margin:0 0 4px;font-size:14px;color:#999">Nick: <strong style="color:#f0f0f0">${nick}</strong></p>
      ${email ? `<p style="margin:0 0 20px;font-size:14px;color:#999">E-mail: <strong style="color:#f0f0f0">${email}</strong></p>` : '<p style="margin:0 0 20px;font-size:14px;color:#999">Sem e-mail cadastrado</p>'}
      <div style="text-align:center">
        <a href="${approveUrl}" style="display:inline-block;background:#1D9E75;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
          ✅ Aprovar acesso
        </a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#555;text-align:center">Se não reconhece esta pessoa, ignore este e-mail.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildApprovedEmail(nick) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f0f0f">
  <div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="margin-bottom:24px">
      <span style="font-size:28px">⚽</span>
      <span style="font-size:18px;font-weight:700;color:#f0f0f0;margin-left:8px">Bolão Snip - 2026</span>
    </div>
    <div style="background:#1a1a1a;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08)">
      <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#f0f0f0">Bem-vindo, ${nick}! 🎉</p>
      <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.5">
        Sua conta foi aprovada. Agora você pode fazer seus palpites no Bolão Snip!
      </p>
      <div style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#3b82f6;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
          Fazer palpites agora
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
