async function getGmailAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    }),
  });
  if (!r.ok) throw new Error('Gmail token refresh failed: ' + await r.text());
  const { access_token } = await r.json();
  return access_token;
}

async function sendEmail(to, subject, html) {
  console.log(`[email] tentando enviar para ${to} | subject: ${subject}`);
  console.log(`[email] vars: REFRESH=${!!process.env.GMAIL_REFRESH_TOKEN} CLIENT_ID=${!!process.env.GOOGLE_CLIENT_ID} SECRET=${!!process.env.GOOGLE_CLIENT_SECRET} ADMIN=${process.env.ADMIN_EMAIL}`);
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.log(`[email] GMAIL_REFRESH_TOKEN não configurado — e-mail para ${to} ignorado`);
    return false;
  }
  try {
    const from = `Bolão Snip <${process.env.ADMIN_EMAIL || 'me'}>`;
    const accessToken = await getGmailAccessToken();
    console.log(`[email] access token obtido, enviando...`);
    const raw = Buffer.from(
      `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `\r\n` +
      html
    ).toString('base64url');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      console.error(`[email] Erro ao enviar para ${to}:`, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] Exceção:', e.message);
    return false;
  }
}

module.exports = { sendEmail };
