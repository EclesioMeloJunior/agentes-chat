# 0260. WhatsApp for agents

- Status: Accepted
- Date: 2026-11-27
- Extends: ADR 0005 (optional services behind an env var), ADR 0173 (approvals), ADR 0085 (who manages connectors)
- Code: the service `deploy/whatsapp/` (`src/http.ts`, `src/sessions.ts`, `src/main.ts`, its `Dockerfile` and
  `NOTICE`), the compose file's `whatsapp` profile; adapter `packages/adapters/src/whatsapp.ts`
  (`WhatsAppGateway`, `createHttpWhatsApp`, `createFakeWhatsApp`); engine `packages/engine/src/whatsapp.ts`
  (`whatsAppStatus`, `connectWhatsApp`, `disconnectWhatsApp`, `createWhatsAppToolSource`); routes
  `apps/server/src/routes/app/whatsapp.ts`; web `apps/web/src/components/WhatsAppCard.tsx` in Settings › Connectors

## Context

People asked for agents that send WhatsApp messages: a reminder to a customer, a note to a supplier, a summary to a
phone. WhatsApp's business API needs a Meta business account, a verified number and paid templates, which a small
team or a self-hosted server rarely has. The other way is to link a phone's own account as a companion device, the
way WhatsApp Web does, by scanning a QR. zapo-js (MIT) speaks that protocol in TypeScript.

## Decision

1. **A service of its own.** The protocol runs in `deploy/whatsapp`, a small Node service over zapo-js, not in the
   server's process: its sockets, keys and reconnects stay out of the core, and the core stays on Postgres alone.
   The service is the compose file's `whatsapp` profile and is on only when the server has `WHATSAPP_URL` (and
   `WHATSAPP_API_KEY`, the bearer both share). Without it nothing about WhatsApp shows.
2. **One phone per workspace.** The service keeps one session per workspace, named by its id, with its keys in a
   SQLite file on its own volume; a session that paired reconnects when the service restarts. It keeps no messages,
   chats or contacts.
3. **Linked in Settings › Connectors.** Whoever may manage connectors sees whether the workspace's phone is linked
   and which number it is. When it is not, "Connect" asks the service for a session and the card shows its QR, a PNG
   the service draws, renewed while it waits; the server passes only a PNG data URL and the app draws nothing it
   didn't check. "Disconnect" logs the companion device out. Both are in the audit log.
4. **A scope and a tool.** `whatsapp:send` gives an agent `send_whatsapp {to, text}`: a number with its country code
   and up to 4096 characters of text. It is in no default set and not in "all tools": a person grants it per agent.
   The tool is sensitive, so each message is an approval request that shows the number and the text, except for an
   agent whose approvals are "Never ask" or a kind of action approved for good (ADR 0173). A confidential thread's
   lock refuses it, as it refuses every tool not on its list (ADR 0190).
5. **Send only.** Agents don't read the phone's chats and nothing that arrives on it reaches an agent. Reading is a
   larger decision (whose conversations, which agent, what is untrusted text) for a later ADR.

## Consequences

- WhatsApp's terms apply to the linked account, and an unofficial client can get a number limited or banned; the
  card and the NOTICE say so, and approvals keep a person in front of every message by default.
- The QR and the keys never reach a client but the person linking the phone, and the service answers only the
  server, on its own network, with the bearer.
- One number per workspace is a limit: a team that wants a number per agent asks for it later, as sessions named
  `<org>-<agent>` with the same service.
- The service's image is built from this repository and CI publishes it on the server's tags
  (`ghcr.io/agentes-chat/whatsapp`). It is optional like the speech image: a platform whose build fails leaves its
  tags where they were and publishes the server without it.

## Addendum of 2026-11-27: groups

People asked for agents that post to a WhatsApp group and watch one (a routine that greets whoever joined). The
phone's groups are a narrower thing to read than its chats: what is said there is said before everyone in it, and the
workspace chose to put its number there.

1. **Sending to a group.** `send_whatsapp` takes `to` (a number) or `group` (a group's name or address), never both.
   A name is matched among the groups the phone is in, accents, case and extra spaces aside; a name two groups share is
   refused with their addresses, and a name or address of a group the phone is not in is refused with its groups'
   names. Both are refused before anyone is asked, and checked again when the approved call runs. The approval names
   the group.
2. **Reading groups, never chats.** `whatsapp:read` gives an agent `read_whatsapp {group?, after?}`: without `group`
   it lists the phone's groups (name, address, size, whether only admins send); with one it returns what was said
   there, oldest first, with a cursor that reads only what came next. Private chats are never kept or read. The scope
   only reads, so a routine may use it; it is in no default set and not in "all tools". What it returns, group names
   included, is outside text (`untrustedBlock`).
3. **In memory only.** The service keeps each group's messages, joins and leaves in memory as they arrive
   (`deploy/whatsapp/src/inbox.ts`: 300 per group, 100 groups per session, 3 days, 2000 characters each), forgotten
   when the phone is unlinked or the service restarts. A cursor of an earlier start reads the whole window again, and
   a read says since when the window holds what was said. Point 2 of the decision ("It keeps no messages") now reads:
   it keeps no chats or contacts, and its groups' recent messages only in memory. Point 5 ("Send only") is replaced by
   this addendum for groups; reading private chats stays out.
4. **The service's routes.** `GET /v1/sessions/{id}/groups` and `GET /v1/sessions/{id}/groups/{group}/messages?after`,
   both 409 while the phone is not linked; `POST …/messages` takes a group's address as `to`.
