import { FileText, Film, Loader2, Scissors, X } from "lucide-react";

import { attachmentDetail, chosenLength, clipLength } from "./attachment-detail";
import type { AssetAttachment } from "./model";

/** An attachment in the composer: what it is, and what the run will be able to do with it. */
export function AttachmentChip({ attachment, imagesReachModel, reading, readsText, onTrim, onRemove }: {
  attachment: AssetAttachment;
  imagesReachModel: boolean;
  reading: boolean;
  readsText: boolean;
  onTrim: () => void;
  onRemove: () => void;
}) {
  const { clip, name, thumbnailDataUrl } = attachment;
  const detail = attachmentDetail(attachment, { imagesReachModel, reading, readsText });
  const unchosen = clip !== undefined && clip.id === undefined && !reading;
  return <div className="attachment-chip">
    <span className="attachment-thumb" data-kind={clip !== undefined ? "clip" : thumbnailDataUrl !== undefined ? "image" : "file"}>
      {thumbnailDataUrl !== undefined
        ? <img src={thumbnailDataUrl} alt="" />
        : clip !== undefined ? <Film size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
      {clip !== undefined && <i>{clip.id === undefined ? clipLength(clip.duration) : chosenLength(clip)}</i>}
    </span>
    <div className="attachment-copy">
      <strong title={name}>{name}</strong>
      <span data-warning={detail.warning}>{reading && <Loader2 size={12} className="spin" aria-hidden="true" />}{detail.text}</span>
    </div>
    {unchosen && <button type="button" className="attachment-choose" onClick={onTrim} aria-label={`Choose the part of ${name} to send`}><Scissors size={13} aria-hidden="true" />Choose the part</button>}
    {clip !== undefined && !unchosen && !reading && <button type="button" className="attachment-icon" onClick={onTrim} aria-label={`Choose the part of ${name} to send`} title="Choose the part to send"><Scissors size={14} aria-hidden="true" /></button>}
    <button type="button" className="attachment-icon" onClick={onRemove} aria-label={`Remove ${name}`}><X size={13} aria-hidden="true" /></button>
  </div>;
}

const isPicture = (asset: AssetAttachment) => asset.thumbnailDataUrl !== undefined;

/** What a sent message showed the model, above its text. */
export function MessagePictures({ attachments }: { attachments: readonly AssetAttachment[] }) {
  const pictures = attachments.filter(isPicture);
  if (pictures.length === 0) return null;
  return <div className="message-pictures">{pictures.map((asset) => (asset.clip !== undefined
    ? <figure key={asset.id} className="message-picture" title={asset.name}>
      <img src={asset.thumbnailDataUrl} alt={`Attached clip: ${asset.name}`} />
      <figcaption><Film size={12} aria-hidden="true" />{chosenLength(asset.clip)}</figcaption>
    </figure>
    : <figure key={asset.id} className="message-picture" title={asset.name}>
      <img src={asset.thumbnailDataUrl} alt={`Attached image: ${asset.name}`} />
    </figure>))}</div>;
}

/** The files a sent message carried with no picture to show, under its text. */
export function MessageFiles({ attachments }: { attachments: readonly AssetAttachment[] }) {
  const files = attachments.filter((asset) => !isPicture(asset));
  if (files.length === 0) return null;
  return <div className="message-files">{files.map((asset) => <span key={asset.id}>
    {asset.clip !== undefined ? <Film size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}{asset.name}
  </span>)}</div>;
}
