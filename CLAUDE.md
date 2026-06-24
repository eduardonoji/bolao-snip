# Bolão Snip - 2026

App de bolão para a Copa do Mundo 2026. Mobile-first, dark mode fixo. Hospedado na Vercel.

## Stack

- **Frontend**: HTML/CSS/JS puro em `index.html`. Zero framework, zero bundler. CSS inline.
- **Backend**: Vercel Serverless Functions (Node.js). Sempre `require`/`module.exports`, nunca `import`/`export` — o projeto não tem `"type": "module"`.
- **Banco**: Neon Postgres via `@neondatabase/serverless`. Única dependência em `package.json`.
- **Jogos**: API externa `https://worldcup26.ir/get/games` + `/get/stadiums`.
- **E-mail**: Resend (opcional). Variáveis `RESEND_API_KEY`, `RESEND_FROM`, `APP_URL`.

## Estrutura de arquivos

```
index.html          # SPA completa (auth, jogos, ranking, admin)
vercel.json         # rewrites + cron diário às 09h Manaus (13h UTC)
package.json        # só @neondatabase/serverless
api/
  _games.js         # módulo compartilhado: fetchGames() — usado por games.js e bolao.js
  games.js          # GET /api/games — proxy da worldcup26.ir
  auth.js           # register, login, pending, all, approve, delete
  bolao.js          # save, my, ranking, profile
  cron.js           # cron de lembretes de aposta por e-mail
```

## Banco de dados

Tabelas criadas automaticamente com `CREATE TABLE IF NOT EXISTS` na primeira chamada de cada handler — sem migrations separadas.

```sql
-- criada em auth.js
users (nick PK, pass, email, status, role, created_at)

-- criada em bolao.js
palpites (id SERIAL PK, nick, game_id, home_score, away_score, created_at, UNIQUE(nick, game_id))
```

- Senha armazenada como `Buffer.from(pass).toString('base64')`.
- Admin hardcoded: nick `"eduardo"` entra como `approved + admin` automaticamente.
- `status`: `'pending'` | `'approved'` | `'rejected'`
- `role`: `'user'` | `'admin'`

## API routes

| Rota | Método | Action | Descrição |
|------|--------|--------|-----------|
| `/api/auth` | POST | `register` | Cadastro com nick, pass, email opcional |
| `/api/auth` | POST | `login` | Login, retorna `{nick, status, role}` |
| `/api/auth` | GET | `pending` | Lista pendentes (admin) |
| `/api/auth` | GET | `all` | Lista todos os usuários (admin) |
| `/api/auth` | POST | `approve` | Aprova ou rejeita usuário (admin) |
| `/api/auth` | POST | `delete` | Exclui conta e palpites (admin) |
| `/api/games` | GET | — | Jogos com horários em UTC, nomes em PT-BR |
| `/api/bolao` | POST | `save` | Upsert de palpite (requer aprovado) |
| `/api/bolao` | GET | `my` | Palpites do usuário autenticado |
| `/api/bolao` | GET | `ranking` | Ranking com pontos em tempo real |
| `/api/bolao` | GET | `profile` | Apostas + pontos de qualquer usuário (auditoria) |
| `/api/cron` | GET | — | Disparado pelo cron da Vercel (protegido por CRON_SECRET) |

## Lógica de jogos (`api/_games.js`)

- Busca `worldcup26.ir/get/games` e `/get/stadiums` em paralelo.
- Converte `local_date` (horário local do estádio) para UTC usando o campo `region` dos estádios:
  - `Eastern` → UTC-4, `Central` → UTC-5, `Western` → UTC-7
- Traduz nomes dos times para PT-BR.
- `status`: `finished === "TRUE"` → `completed`; `time_elapsed` com dígito → `in_progress`; else → `scheduled`.
- `homeScore`/`awayScore`: `parseInt` para jogos em andamento/encerrados, `null` para agendados.

## Pontuação

```
Placar exato  → +10 pts
Resultado certo (vitória/empate) → +5 pts
Gols de um time correto → +2 pts
```

Função `calcPoints(p, game)` implementada identicamente em `bolao.js` (backend) e `index.html` (frontend para cálculo parcial ao vivo).

## Frontend — SPA

- Sessão em memória: `let session = { nick, pass, status, role }`. Sem `localStorage`.
- Senha trafega em todo request autenticado (nick+pass) para autenticar no backend.
- Três telas: `screen-auth`, `screen-pending`, `screen-main`.
- Janela do dia: 06h–05h59 horário de Manaus (UTC-4 fixo). Jogos fora da janela são ocultados.
- Auto-refresh de jogos a cada 30s quando há `status === 'in_progress'`.
- Ranking ao vivo: pontos parciais calculados no frontend com placar atual, sem polling.

## Variáveis de ambiente (Vercel)

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DATABASE_URL` | Sim | Injetada pela integração Neon+Vercel |
| `RESEND_API_KEY` | Não | Chave do Resend para e-mails de lembrete |
| `RESEND_FROM` | Não | Ex: `Bolão Snip <noreply@seudominio.com>` |
| `APP_URL` | Não | URL do app para o link no e-mail |
| `CRON_SECRET` | Auto | Gerado pela Vercel, protege `/api/cron` |

## Regras de desenvolvimento

- Nunca usar `import`/`export` nas API routes — sempre `require`/`module.exports`.
- Nunca usar `localStorage` no frontend.
- Nunca hardcodar credenciais.
- Nunca criar migrations separadas — tabelas criadas no handler com `IF NOT EXISTS`.
- Não adicionar dependências além de `@neondatabase/serverless`.
- Dark mode fixo e absoluto — nunca respeitar preferência do sistema.
- Exibir apenas jogos dentro da janela 06h–05h59 Manaus — nunca outros dias.
- Não fazer fetch HTTP interno entre serverless functions — usar `require('./_games')` diretamente.
