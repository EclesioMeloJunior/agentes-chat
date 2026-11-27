import { useWhatsApp, useWhatsAppActions, type WhatsAppStatus } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, type ChipTone, Dialog, DialogFooter, type IconName, InfoHint, List } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/*
 * The workspace's WhatsApp number for agents (ADR 0262), in Settings › Connectors for who manages connectors, only
 * where the server has the WhatsApp service: whether a phone is linked and which, or the QR to link one, read again
 * every 2 s while it waits (`useWhatsApp`).
 */

const STATE_CHIP: Record<WhatsAppStatus["state"], { icon?: IconName; tone?: ChipTone }> = {
  off: {},
  starting: { icon: "waiting", tone: "waiting" },
  qr: { icon: "waiting", tone: "waiting" },
  open: { icon: "check", tone: "done" },
  closed: { icon: "alert", tone: "waiting" },
};

/** The digits with a plus, the way WhatsApp shows a number it has no name for. */
const shown = (phone: string | null) => (phone ? `+${phone}` : "");

export function WhatsAppPanel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const status = useWhatsApp(org.id, admin);
  const { connect, disconnect } = useWhatsAppActions(org.id);
  const [unlinking, setUnlinking] = useState(false);
  const view = status.data;
  // No service on this server (or not who links it): nothing about WhatsApp shows.
  if (!admin || (!view && !status.isError) || (view && !view.available)) return null;

  const state = view?.state ?? "off";
  const chip = STATE_CHIP[state];
  const failed = status.isError || connect.isError;
  const linked = state === "open" || state === "closed";

  return (
    <section className="gh-app wa-panel" aria-labelledby="sec-whatsapp">
      <div className="gh-app__head">
        <div className="ac-hintline">
          <h3 id="sec-whatsapp" className="ac-card__title">
            {t("whatsApp.title")}
          </h3>
          <InfoHint name={t("common.about", { label: t("whatsApp.title") })}>{t("whatsApp.text")}</InfoHint>
        </div>
        {view && (
          <Chip icon={chip.icon} tone={chip.tone}>
            {t(`whatsApp.state.${state}`)}
          </Chip>
        )}
      </div>
      <List aria-label={t("whatsApp.title")}>
        {failed && !view ? (
          <div className="ac-list__row">
            <span className="small muted">{t("whatsApp.failed")}</span>
            <span className="ac-acts">
              <Button size="sm" loading={status.isFetching} onClick={() => void status.refetch()}>
                {t("whatsApp.retry")}
              </Button>
            </span>
          </div>
        ) : linked ? (
          <div className="ac-list__row">
            <span className="list-col">
              <span className="list-title">{shown(view?.phone ?? null) || t("whatsApp.title")}</span>
              <span className="small muted">{t(state === "open" ? "whatsApp.linked" : "whatsApp.closed")}</span>
            </span>
            <span className="ac-acts">
              <Button variant="link" className="store-danger" onClick={() => setUnlinking(true)}>
                {t("whatsApp.disconnect")}
              </Button>
            </span>
          </div>
        ) : state === "qr" && view?.qr ? (
          <div className="ac-list__row wa-panel__scan">
            <img className="wa-panel__qr" src={view.qr} alt={t("whatsApp.qrAlt")} width={200} height={200} />
            <span className="list-col">
              <span className="list-title">{t("whatsApp.scanTitle")}</span>
              <span className="small muted">{t("whatsApp.scanSteps")}</span>
              <span className="ac-acts">
                <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                  {t("common.cancel")}
                </Button>
              </span>
            </span>
          </div>
        ) : (
          <div className="ac-list__row">
            <span className="small muted">
              {connect.isError
                ? errorText(t, connect.error)
                : t(state === "starting" || state === "qr" ? "whatsApp.starting" : "whatsApp.off")}
            </span>
            <span className="ac-acts">
              <Button
                size="sm"
                variant="primary"
                loading={connect.isPending || state === "starting" || state === "qr"}
                disabled={connect.isPending || state === "starting" || state === "qr"}
                onClick={() => connect.mutate()}
              >
                {t("whatsApp.connect")}
              </Button>
            </span>
          </div>
        )}
      </List>
      <Dialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title={t("whatsApp.remove.title")}
        description={t("whatsApp.remove.text")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setUnlinking(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={disconnect.isPending}
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate(undefined, { onSuccess: () => setUnlinking(false) })}
          >
            {t("whatsApp.disconnect")}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
