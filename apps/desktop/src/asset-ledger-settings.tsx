import { useCallback, useEffect, useState } from "react";
import { AudioLines, Box, Check, Copy, ExternalLink, FileBox, Film, ImageIcon, PersonStanding, RefreshCw } from "lucide-react";

import { ledgerAssetUrl, matchesUploadQuery, type AssetLedgerView, type LedgerAsset } from "../shared/asset-ledger";
import { defaultInstanceId, type StudioStatus } from "../shared/studio-status";
import { getAssetLedger, getAssetThumbnail, insertLedgerAsset } from "./platform";
import { SettingsRow } from "./settings-parts";

/**
 * Everything Roqer uploaded to Roblox from this computer, in Settings: what
 * each asset is, its id, what moderation said, and the two things someone does
 * next with one, copy its id and put it in the open place. The list is the
 * main process's ledger, read fresh each time the section opens.
 */

/** How many rows the section shows at once; the filter narrows a long list. */
const MAX_SHOWN = 200;
/** Thumbnails already fetched, by asset id, so scrolling does not ask the bridge again. */
const thumbnails = new Map<string, string | null>();

function typeIcon(type: string) {
  const kind = type.toLowerCase();
  if (/animation/.test(kind)) return <PersonStanding size={18} aria-hidden="true" />;
  if (/model|mesh|package/.test(kind)) return <Box size={18} aria-hidden="true" />;
  if (/image|decal|texture/.test(kind)) return <ImageIcon size={18} aria-hidden="true" />;
  if (/audio|sound/.test(kind)) return <AudioLines size={18} aria-hidden="true" />;
  if (/video/.test(kind)) return <Film size={18} aria-hidden="true" />;
  return <FileBox size={18} aria-hidden="true" />;
}

/** Roblox draws thumbnails for pictures and models; a sound or an animation has only its icon. */
function hasThumbnail(type: string): boolean {
  return /model|mesh|package|image|decal|texture/i.test(type);
}

function Thumbnail({ asset, endpoint }: { asset: LedgerAsset; endpoint: string }) {
  const [src, setSrc] = useState<string | null | undefined>(thumbnails.get(asset.assetId));
  useEffect(() => {
    if (!hasThumbnail(asset.assetType) || thumbnails.has(asset.assetId)) return;
    let current = true;
    void getAssetThumbnail({ endpoint, assetId: asset.assetId }).then((result) => {
      const value = result.ok ? result.dataUrl : null;
      thumbnails.set(asset.assetId, value);
      if (current) setSrc(value);
    });
    return () => { current = false; };
  }, [asset.assetId, asset.assetType, endpoint]);
  if (typeof src === "string") return <img className="asset-thumbnail" src={src} alt="" draggable={false} />;
  return <span className="asset-icon">{typeIcon(asset.assetType)}</span>;
}

function moderationTone(state: string | undefined): "approved" | "pending" | "rejected" | "unknown" {
  const value = (state ?? "").toLowerCase();
  if (value === "approved") return "approved";
  if (value === "rejected") return "rejected";
  if (value === "reviewing" || value === "pending") return "pending";
  return "unknown";
}

const COPIED_FOR_MS = 1_600;

function AssetRow({ asset, endpoint, placeId, placeName, onInserted }: {
  asset: LedgerAsset;
  endpoint: string;
  placeId: string | null;
  placeName: string | undefined;
  onInserted: (text: { ok: boolean; message: string }) => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [inserting, setInserting] = useState(false);
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const reference = `rbxassetid://${asset.assetId}`;
  const copy = () => {
    if (navigator.clipboard === undefined) { setCopied("failed"); return; }
    navigator.clipboard.writeText(reference).then(() => setCopied("copied"), () => setCopied("failed"));
  };
  const insert = async () => {
    setInserting(true);
    try {
      onInserted(await insertLedgerAsset({ endpoint, assetId: asset.assetId, instanceId: placeId }));
    } finally {
      setInserting(false);
    }
  };
  const tone = moderationTone(asset.moderationState);
  return <li className="asset-row">
    <Thumbnail asset={asset} endpoint={endpoint} />
    <div className="asset-text">
      <strong title={asset.displayName}>{asset.displayName || `Asset ${asset.assetId}`}</strong>
      <span>
        {asset.assetType} · <code>{asset.assetId}</code>
        {asset.imageId ? <> · image <code>{asset.imageId}</code></> : null}
        {asset.moderationState && <> · <span className="upload-moderation" data-tone={tone} title="Moderation, as Roblox reported it">{asset.moderationState}</span></>}
        {" · "}{new Date(asset.uploadedAt).toLocaleDateString()}
        {asset.fileName ? <> · from {asset.fileName}</> : null}
      </span>
    </div>
    <div className="asset-actions">
      <button type="button" className="small-button" onClick={copy} title={copied === "copied" ? "Copied" : `Copy ${reference}`} aria-label={`Copy ${reference}`} data-state={copied}>
        {copied === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      {placeId !== null && <button
        type="button"
        className="small-button"
        onClick={() => void insert()}
        disabled={inserting}
        title={placeName === undefined ? "Insert into the connected place" : `Insert into ${placeName}`}
      >
        {inserting ? "Inserting…" : "Insert"}
      </button>}
      <a className="small-button" href={ledgerAssetUrl(asset)} target="_blank" rel="noreferrer" title="Open on Roblox" aria-label={`Open ${asset.displayName} on Roblox`}>
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    </div>
  </li>;
}

export function AssetLedgerSettings({ studioStatus, endpoint }: { studioStatus: StudioStatus; endpoint: string }) {
  const [ledger, setLedger] = useState<AssetLedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    const result = await getAssetLedger();
    if (result.ok) {
      setLedger(result.ledger);
      setError(null);
    } else {
      setError(result.message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const placeId = studioStatus.kind === "connected" ? defaultInstanceId(studioStatus) : null;
  const placeName = studioStatus.kind === "connected" ? studioStatus.placeName : undefined;
  const assets = ledger?.assets ?? [];
  const shown = assets.filter((asset) => matchesUploadQuery(asset, query)).slice(0, MAX_SHOWN);
  const detail = error !== null
    ? error
    : ledger === null
      ? "Reading what this computer uploaded…"
      : assets.length === 0
        ? "Nothing uploaded from this computer yet. Uploads the agent makes are recorded here, and a file uploaded once is not uploaded again."
        : `${assets.length} asset${assets.length === 1 ? "" : "s"} uploaded from this computer. The agent can list them, and a file whose exact bytes went up before is answered from this list instead of uploaded again.`;

  return <>
    <SettingsRow title="Your uploads" detail={detail}>
      {assets.length > 0 && <input
        className="asset-filter"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name, id or type"
        aria-label="Filter uploads"
      />}
      <button type="button" className="small-button" onClick={() => void load()} aria-label="Refresh uploads" title="Refresh"><RefreshCw size={14} aria-hidden="true" /></button>
    </SettingsRow>
    {ledger?.notice !== undefined && <p className="custom-message">{ledger.notice}</p>}
    {message !== null && <p className={`custom-message${message.ok ? "" : " error"}`}>{message.message}</p>}
    {shown.length > 0 && <ul className="asset-ledger">
      {shown.map((asset) => <AssetRow key={asset.assetId} asset={asset} endpoint={endpoint} placeId={placeId} placeName={placeName} onInserted={setMessage} />)}
    </ul>}
    {assets.length > 0 && shown.length === 0 && <p className="custom-message">No upload matches that filter.</p>}
    {shown.length === MAX_SHOWN && <p className="custom-message">Showing the newest {MAX_SHOWN}; narrow the filter to find older ones.</p>}
  </>;
}
