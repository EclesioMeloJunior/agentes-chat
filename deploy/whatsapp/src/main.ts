/**
 * The `whatsapp` service of docker-compose.yml (ADR 0261). `WHATSAPP_API_KEY`: the token the app sends, the same in
 * both; `WHATSAPP_DATA`: where the sessions' keys are kept (a volume); `PORT`: 8080.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createHandler } from "./http.ts";
import { createZapoSessions } from "./sessions.ts";

const dataDir = process.env.WHATSAPP_DATA || "/data";
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.WHATSAPP_API_KEY ?? "";
mkdirSync(dataDir, { recursive: true });

const sessions = await createZapoSessions(dataDir);
const server = createServer(createHandler(sessions, apiKey));
server.listen(port, () => {
  console.log(
    `whatsapp sidecar on :${port}${apiKey ? "" : " (no WHATSAPP_API_KEY: any caller on its network is let in)"}`,
  );
});
await sessions.resume();

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
