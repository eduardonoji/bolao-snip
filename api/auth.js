const { neon } = require("@neondatabase/serverless");

const ADMIN_NICK = "eduardo";

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      nick TEXT PRIMARY KEY,
      pass TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
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

  if (action === "register" && req.method === "POST") {
    const { nick, pass } = req.body;
    if (!nick || !pass) return res.status(400).json({ error: "Dados inválidos." });

    const slug = nick.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(slug))
      return res.status(400).json({ error: "Apelido inválido (2–20 chars, letras/números/_)." });

    const existing = await sql`SELECT nick FROM users WHERE nick = ${slug}`;
    if (existing.length > 0) return res.status(409).json({ error: "Apelido já em uso." });

    const status = slug === ADMIN_NICK ? "approved" : "pending";
    const role   = slug === ADMIN_NICK ? "admin"    : "user";
    const passB64 = Buffer.from(pass).toString("base64");

    await sql`INSERT INTO users (nick, pass, status, role) VALUES (${slug}, ${passB64}, ${status}, ${role})`;
    return res.status(200).json({ ok: true, status, role });
  }

  if (action === "login" && req.method === "POST") {
    const { nick, pass } = req.body;
    const slug = (nick || "").trim().toLowerCase();
    const rows = await sql`SELECT * FROM users WHERE nick = ${slug}`;
    if (rows.length === 0) return res.status(404).json({ error: "Apelido não encontrado." });

    const user = rows[0];
    if (user.pass !== Buffer.from(pass).toString("base64"))
      return res.status(401).json({ error: "Senha incorreta." });

    return res.status(200).json({ ok: true, nick: user.nick, status: user.status, role: user.role });
  }

  if (action === "pending" && req.method === "GET") {
    const { adminNick, adminPass } = req.query;
    const ok = await checkAdmin(sql, adminNick, adminPass);
    if (!ok) return res.status(403).json({ error: "Não autorizado." });

    const rows = await sql`SELECT nick, status FROM users WHERE status = 'pending'`;
    return res.status(200).json({ pending: rows });
  }

  if (action === "approve" && req.method === "POST") {
    const { adminNick, adminPass, targetNick, decision } = req.body;
    const ok = await checkAdmin(sql, adminNick, adminPass);
    if (!ok) return res.status(403).json({ error: "Não autorizado." });

    const newStatus = decision === "approve" ? "approved" : "rejected";
    await sql`UPDATE users SET status = ${newStatus} WHERE nick = ${targetNick}`;
    return res.status(200).json({ ok: true, status: newStatus });
  }

  return res.status(404).json({ error: "Ação não encontrada." });
};

async function checkAdmin(sql, nick, pass) {
  const slug = (nick || "").trim().toLowerCase();
  const rows = await sql`SELECT * FROM users WHERE nick = ${slug}`;
  if (rows.length === 0) return false;
  const user = rows[0];
  return user.role === "admin" && user.pass === Buffer.from(pass || "").toString("base64");
}
