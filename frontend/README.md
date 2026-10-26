# frontend

React 19 single-page app (Vite, Tailwind CSS v4, React Router, socket.io-client).

## Run

```bash
npm install
cp .env.example .env     # optional; defaults work for local development
npm run dev              # http://localhost:5173
```

In development, Vite proxies `/api` and `/socket.io` to the backend (`VITE_BACKEND_PROXY_TARGET`,
default `http://localhost:5000`), so the browser talks to one origin and session cookies just work.
For a deployed build, set `VITE_API_BASE_URL` or serve the build behind the same reverse proxy as the
API.

| Script | Purpose |
|---|---|
| `npm run dev` | development server with hot reload |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build locally |

## Structure

```
src/App.jsx           route table (workforce pages are lazy-loaded)
src/api/              one module per backend area; httpClient.js handles cookies, CSRF and errors
src/auth/             AuthContext: session state and CSRF token
src/components/       AppShell (role-aware sidebar), RouteGuards, ui.jsx design primitives, feature panels
src/hooks/            useApiResource (load/abort/error), useSocket, useAgentTelemetry
src/pages/            one file per screen
src/constants/        routes and roles, messages, socket event names
src/validation/       client-side form checks (the backend validates again)
```

Route guards only steer navigation; the backend authorises every request.
