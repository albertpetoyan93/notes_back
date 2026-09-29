# Auto Deploy

Pushing to `main` deploys automatically via GitHub Actions.

## Required GitHub Secrets

Add these in each repo: **Settings → Secrets and variables → Actions**

| Secret | Example | Used by |
|---|---|---|
| `DEPLOY_HOST` | `note.annaniks.com` or EC2 hostname | both |
| `DEPLOY_USER` | `ubuntu` or `ec2-user` | both |
| `DEPLOY_SSH_KEY` | private SSH key (full PEM) | both |
| `DEPLOY_PORT` | `22` (optional) | both |
| `DEPLOY_PATH_BACK` | `/var/www/notes_app/notes_back` | backend |
| `DEPLOY_PATH_FRONT` | `/var/www/notes_app/notes_front` | frontend |
| `VITE_APP_API_URL` | `https://note.annaniks.com` | frontend (creates `.env` if missing) |

## Server one-time setup

```bash
# dirs
sudo mkdir -p /var/www/notes_app
sudo chown -R $USER:$USER /var/www/notes_app

# backend env (never overwritten by deploy)
cp notes_back/env/production.env /var/www/notes_app/notes_back/env/production.env
# edit DB credentials, JWT secrets, etc.

# frontend env (optional; workflow can create from VITE_APP_API_URL)
echo "VITE_APP_API_URL=https://note.annaniks.com" > /var/www/notes_app/notes_front/.env

# install pm2 once
npm i -g pm2
pm2 startup
```

## Manual deploy

In GitHub: **Actions → Deploy Backend/Frontend → Run workflow**

## Notes

- `env/production.env` and frontend `.env` are **not** overwritten by deploy
- Backend runs `npm run migrate:prod` on each deploy
- PM2 apps: `notes-backend`, `notes-frontend`
