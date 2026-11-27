import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * Settings → Connectors' WhatsApp card (ADR 0260): nothing without the service, the QR to scan once someone links a
 * phone, then the number with its Unlink. CI's geometry check lays out each of these screens at 1280 and 320.
 */
const OFF = { available: true, state: "off", qr: null, qrExpiresAt: null, phone: null, reason: null } as const;

async function open(whatsApp?: typeof OFF | (Omit<typeof OFF, "state" | "phone"> & { state: "open"; phone: string })) {
  const state = seedState();
  state.whatsApp = whatsApp ? { ...whatsApp } : undefined;
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  return state;
}

const card = () => screen().queryByRole("region", { name: "WhatsApp" });

describe("WhatsApp in Settings → Connectors", () => {
  test("a server without the WhatsApp service shows nothing of it", async () => {
    await open();
    expect(card()).toBeNull();
  });

  test("not linked: Link a phone, then the QR to scan with its steps", async () => {
    const state = await open(OFF);
    const panel = card();
    if (!panel) throw new Error("no WhatsApp card");
    expect(within(panel).getByText("Nenhum celular conectado ainda.")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Conectar um celular" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "whatsapp.connect")).toBe(true);
    const qr = within(panel).getByRole("img", { name: "QR code para conectar o WhatsApp" });
    expect(qr.getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(within(panel).getByText("Escaneie este código com o celular")).toBeTruthy();
  });

  test("linked: the number and Unlink, which asks first", async () => {
    const state = await open({ ...OFF, state: "open", phone: "5511988887777" });
    const panel = card();
    if (!panel) throw new Error("no WhatsApp card");
    expect(within(panel).getByText("+5511988887777")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Desconectar" }));
    await settle(2);
    const dialog = screen().getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "whatsapp.disconnect")).toBe(true);
  });
});
