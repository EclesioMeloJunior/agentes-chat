import { WhatsAppError } from "@agenteschat/adapters";
import { connectWhatsApp, disconnectWhatsApp, whatsAppStatus } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Connectors"];

const WhatsAppView = z
  .object({
    available: z.boolean().openapi({ description: "False when this server has no WhatsApp service (`WHATSAPP_URL`)." }),
    state: z.enum(["off", "starting", "qr", "open", "closed"]).openapi({
      description:
        "`off`: no phone linked. `starting`: connecting. `qr`: waiting for the QR to be scanned. `open`: linked and online. `closed`: linked but offline, reconnecting.",
    }),
    qr: z
      .string()
      .nullable()
      .openapi({ description: "While `qr`: the QR to scan with WhatsApp › Linked devices, a PNG data URL." }),
    qrExpiresAt: z.string().nullable().openapi({ description: "When this QR is replaced by the next one." }),
    phone: z.string().nullable().openapi({ description: "The linked phone's number, digits with the country code." }),
    reason: z.string().nullable().openapi({ description: "While `closed`: why, as a short word." }),
  })
  .openapi("WhatsApp");

const unavailable = { 502: errorResponse("The WhatsApp service didn't answer (`whatsapp_unavailable`)") };
const tooMany = { 429: errorResponse("Too many tries (`rate_limited`)") };

/** Limits new QR sessions, each a socket to WhatsApp. */
const CONNECTS = { limit: 10, windowMs: 60_000 };

/**
 * The workspace's WhatsApp number (ADR 0261), for whoever manages connectors: whether it is linked, the QR to link it,
 * and the logout. The QR never leaves this route but to that person.
 */
export function whatsAppRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  const serviceDown = (c: Context, error: unknown) => {
    if (error instanceof WhatsAppError)
      return apiError(c, 502, "whatsapp_unavailable", "The WhatsApp service didn't answer. Try again in a moment.");
    throw error;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/whatsapp",
      tags,
      security,
      summary: "Whether the workspace's WhatsApp number is linked, or the QR to link it",
      description:
        "Only who may manage connectors. While `state` is `qr` or `starting`, read again every few seconds: the QR is renewed until it is scanned.",
      request: { params: OrgParams },
      responses: { 200: json(WhatsAppView), ...errors, ...unavailable },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      try {
        return c.json(await whatsAppStatus(db, adapters.whatsapp, c.get("user").id, orgId), 200);
      } catch (error) {
        return serviceDown(c, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/whatsapp/connect",
      tags,
      security,
      summary: "Start linking a phone (a QR follows) or reconnect a linked one",
      description: "Only who may manage connectors. Recorded in the audit log (`whatsapp.connect_started`).",
      request: { params: OrgParams },
      responses: { 200: json(WhatsAppView), ...errors, ...unavailable, ...tooMany },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      if (!(await adapters.rateLimiter.consume(`whatsapp-connect:${orgId}`, CONNECTS)).allowed)
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      try {
        return c.json(await connectWhatsApp(db, adapters.whatsapp, userId, orgId), 200);
      } catch (error) {
        return serviceDown(c, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/whatsapp",
      tags,
      security,
      summary: "Unlink the workspace's WhatsApp number",
      description:
        "Only who may manage connectors. Logs this server out of the phone's linked devices; agents can't send until a phone is linked again. Recorded in the audit log (`whatsapp.disconnected`).",
      request: { params: OrgParams },
      responses: { 204: { description: "Unlinked" }, ...errors, ...unavailable },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      try {
        await disconnectWhatsApp(db, adapters.whatsapp, c.get("user").id, orgId);
      } catch (error) {
        return serviceDown(c, error);
      }
      return c.body(null, 204);
    },
  );

  return app;
}
