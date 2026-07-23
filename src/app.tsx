/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cockpit SpyServer — control per-dongle Airspy SpyServer network sharing on
 * AryaOS. SpyServer streams a compressed/decimated RTL-SDR over TCP for remote
 * SDR clients (SDR#, SDRangel, SDR++) via spyserver://host:port. There is no
 * HTTP status endpoint (it's a raw TCP protocol), so this drives and reads the
 * `aryaos-sdr` helper: `list`, `share-status`, `share N spyserver|off`.
 */

import React, { useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;
const SDR = "/usr/local/sbin/aryaos-sdr";
const BASE_PORT = 5555; // per-dongle port = BASE_PORT + index (mirrors the backend)

/* ---- shapes ---- */

interface Dongle {
    index: number;
    vendor?: string;
    product?: string;
    serial?: string;
}

interface ShareStatus {
    rtltcp: string;
    soapyremote: string;
    spyserver: string; // CSV of active aryaos-spyserver@N.service units
    spyserver_available: boolean; // is the proprietary binary present on this image?
}

interface SdrState {
    dongles: Dongle[];
    status: ShareStatus | null;
    loaded: boolean;
    error: string | null;
    refresh: () => void;
}

/* ---- data access ---- */

// Indices with an active SpyServer instance, parsed from the share-status CSV
// (e.g. "aryaos-spyserver@0.service,aryaos-spyserver@2.service" -> [0, 2]).
function streamingIndices(status: ShareStatus | null): Set<number> {
    const out = new Set<number>();
    for (const m of (status?.spyserver ?? "").matchAll(/@(\d+)\.service/g))
        out.add(Number(m[1]));
    return out;
}

// Is any *other* raw share (rtl_tcp / SoapyRemote) holding a device? Used only
// to surface a hint — a dongle can do one job at a time.
function otherShareActive(status: ShareStatus | null): boolean {
    return !!(status?.rtltcp?.trim()) || (status?.soapyremote === "active");
}

function useSdr(): SdrState {
    const [dongles, setDongles] = useState<Dongle[]>([]);
    const [status, setStatus] = useState<ShareStatus | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = () => {
        cockpit.spawn([SDR, "list"], { superuser: "try", err: "message" })
                .then((o: string) => { setDongles((JSON.parse(o).devices ?? []) as Dongle[]); setError(null) })
                .catch((e: { message?: string }) => { setDongles([]); setError(e?.message || "aryaos-sdr list failed") })
                .finally(() => setLoaded(true));
        cockpit.spawn([SDR, "share-status"], { superuser: "try", err: "message" })
                .then((o: string) => setStatus(JSON.parse(o) as ShareStatus))
                .catch(() => setStatus(null));
    };

    useEffect(() => {
        refresh();
        const id = window.setInterval(refresh, 4000);
        return () => window.clearInterval(id);
    }, []);

    return { dongles, status, loaded, error, refresh };
}

/* ---- helpers ---- */

const Row = ({ term, children }: { term: string, children: React.ReactNode }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

/* ---- dongle card ---- */

const DongleCard = ({ dongle, streaming, sdr, busyElsewhere }:
    { dongle: Dongle, streaming: boolean, sdr: SdrState, busyElsewhere: boolean }) => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const host = window.location.hostname;
    const port = BASE_PORT + dongle.index;
    const url = `spyserver://${host}:${port}`;

    const act = (mode: "spyserver" | "off") => {
        setPending(true);
        setError(null);
        cockpit.spawn([SDR, "share", String(dongle.index), mode], { superuser: "require", err: "message" })
                .then(() => sdr.refresh())
                .catch((e: { message?: string }) => setError(e?.message || `share ${mode} failed`))
                .finally(() => { setPending(false); window.setTimeout(sdr.refresh, 800) });
    };

    return (
        <Card>
            <CardTitle>
                <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                    <FlexItem><Label color={streaming ? "green" : "grey"}>{streaming ? _("Streaming") : _("Idle")}</Label></FlexItem>
                    <FlexItem>{cockpit.format(_("SDR $0"), dongle.index)}</FlexItem>
                </Flex>
            </CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    <Row term={_("Device")}>{dongle.product || dongle.vendor || "RTL-SDR"}</Row>
                    <Row term={_("Serial")}><span className="ss-mono">{dongle.serial || "—"}</span></Row>
                    <Row term={_("Port")}>{port}</Row>
                    {streaming && <Row term={_("Client URL")}><span className="ss-mono">{url}</span></Row>}
                </DescriptionList>

                {streaming && (
                    <Alert
variant="warning" isInline isPlain className="ss-alert"
                        title={_("Unauthenticated — anyone who can reach this port controls the dongle. Keep it on a trusted/VPN network; the firewall does not open it by default.")}
                    />
                )}
                {!streaming && busyElsewhere && (
                    <Alert
variant="info" isInline isPlain className="ss-alert"
                        title={_("Starting SpyServer stops this dongle's current decoder or share (a dongle does one job at a time).")}
                    />
                )}

                <div className="ss-actions">
                    {streaming
                        ? <Button variant="secondary" isDisabled={pending} onClick={() => act("off")}>{_("Stop sharing")}</Button>
                        : <Button variant="primary" isDisabled={pending} onClick={() => act("spyserver")}>{_("Share via SpyServer")}</Button>}
                </div>
                {error && <Alert variant="danger" isInline isPlain className="ss-alert" title={error} />}
            </CardBody>
        </Card>
    );
};

/* ---- application ---- */

export const Application = () => {
    const sdr = useSdr();
    const streaming = streamingIndices(sdr.status);
    const available = sdr.status?.spyserver_available !== false; // assume yes until status says no
    const busyElsewhere = otherShareActive(sdr.status);

    return (
        <div className="ss-page">
            <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsLg" }}>
                <FlexItem>
                    <Card>
                        <CardBody>
                            <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsMd" }}>
                                <FlexItem><b>{_("SpyServer network sharing")}</b></FlexItem>
                                <FlexItem flex={{ default: "flex_1" }} />
                                <FlexItem><Button variant="secondary" onClick={() => sdr.refresh()}>{_("Refresh")}</Button></FlexItem>
                            </Flex>
                            <div className="ss-sub" style={{ marginBlockStart: "6px" }}>
                                {_("Stream an onboard RTL-SDR to a remote SDR client (SDR#, SDRangel, SDR++). Sharing a dongle stops its decoder; stop sharing, then re-apply a role, to resume decoding.")}
                            </div>
                        </CardBody>
                    </Card>
                </FlexItem>

                {!available && (
                    <FlexItem>
                        <Alert
variant="warning" isInline
                            title={_("SpyServer is not installed on this image — the Airspy binary could not be fetched at build time. Use rtl_tcp or SoapyRemote sharing instead (Radios & SDRs).")}
                        />
                    </FlexItem>
                )}

                {sdr.error && (
                    <FlexItem>
                        <Alert variant="danger" isInline title={_("Could not read SDRs")}>{sdr.error}</Alert>
                    </FlexItem>
                )}

                {sdr.loaded && sdr.dongles.length === 0 && !sdr.error && (
                    <FlexItem>
                        <Alert variant="info" isInline title={_("No RTL-SDR dongles detected. Plug one in and Refresh.")} />
                    </FlexItem>
                )}

                {available && sdr.dongles.length > 0 && (
                    <FlexItem>
                        <Gallery hasGutter minWidths={{ default: "320px" }}>
                            {sdr.dongles.map(d => (
                                <DongleCard
key={d.index} dongle={d}
                                    streaming={streaming.has(d.index)} sdr={sdr}
                                    busyElsewhere={busyElsewhere && !streaming.has(d.index)}
                                />
                            ))}
                        </Gallery>
                    </FlexItem>
                )}
            </Flex>
        </div>
    );
};
