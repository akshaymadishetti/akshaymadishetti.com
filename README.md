# Akshay Madishetti Website click here  https://web-deployer--akshaymadishett.replit.app/

A polished full-stack personal portfolio built with a dependency-free Node.js backend and a responsive frontend.

## Run Locally

```powershell
npm start
```

Then open:

```text
http://localhost:3000
```

## Backend API

- `GET /api/health` checks server status.
- `GET /api/profile` returns profile, services, skills, and stats.
- `GET /api/projects` returns featured work.
- `POST /api/contact` validates and stores contact requests in `data/messages.json`.
- `GET /api/messages` returns saved messages only when `ADMIN_TOKEN` is set and sent as `Authorization: Bearer <token>`.

## Configuration

Copy `.env.example` to `.env` if you want to set environment variables:

```powershell
Copy-Item .env.example .env
```

The backend can optionally forward new contact messages to `CONTACT_WEBHOOK_URL`.
