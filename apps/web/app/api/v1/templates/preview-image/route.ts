import sharp from "sharp";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok, rateLimit } from "@/lib/api";

const MAX_UPLOAD = 8 * 1024 * 1024; // 8 MB raw upload
const MAX_PIXELS = 40_000_000; // decode bomb guard
const MAX_WIDTH = 1600;
const BUCKET = "tenant-assets";

function sniff(b: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null; // SVG and everything else rejected
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operator/admin uploads the vendor's pre-printed ticket image. PREVIEW ONLY: it is never sent to the printer. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  if (!rateLimit(`tpl-img:${user.id}`, 10, 60_000)) return fail(429, "rate_limited", "Too many uploads. Try again shortly.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const orgId = String(form?.get("organization_id") ?? "");
  if (!(file instanceof File) || !uuid.test(orgId)) return fail(400, "invalid_request", "Choose a PNG, JPEG or WebP image.");
  const { data: allowed } = await user.sb.rpc("has_permission", { org: orgId, perm: "ticket.image" });
  if (!allowed) return fail(403, "forbidden", "You do not have permission to change the ticket image.");
  if (file.size > MAX_UPLOAD) return fail(413, "too_large", "The image is too large (max 8 MB).");

  const raw = new Uint8Array(await file.arrayBuffer());
  if (!sniff(raw)) return fail(415, "unsupported_type", "Only PNG, JPEG or WebP images are accepted.");

  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await sharp(raw, { limitInputPixels: MAX_PIXELS, failOn: "error" })
      .rotate() // honour phone EXIF orientation, then metadata is dropped below
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    return fail(422, "corrupt_image", "That image could not be read. Try another photo.");
  }
  if (out.data.length > 2 * 1024 * 1024) return fail(413, "too_large", "The optimised image is still too large.");

  const svc = serviceClient();
  const { data: prev } = await svc.from("tenant_assets").select("path,version").eq("organization_id", orgId).eq("kind", "ticket_preview").maybeSingle();
  const version = (prev?.version ?? 0) + 1;
  const path = `${orgId}/ticket-preview-v${version}.webp`;
  const up = await svc.storage.from(BUCKET).upload(path, out.data, { contentType: "image/webp", upsert: false });
  if (up.error) return fail(507, "storage_error", "Could not store the image. The existing ticket image was kept.");
  const { error } = await svc.from("tenant_assets").upsert({
    organization_id: orgId, kind: "ticket_preview", path, mime: "image/webp", bytes_original: file.size, bytes_optimized: out.data.length,
    width: out.info.width, height: out.info.height, checksum: createHash("sha256").update(out.data).digest("hex"), version,
    uploaded_by: user.id, updated_at: new Date().toISOString(),
  });
  if (error) {
    await svc.storage.from(BUCKET).remove([path]);
    return fail(500, "save_failed", "Could not save the image. The existing ticket image was kept.");
  }
  if (prev?.path) await svc.storage.from(BUCKET).remove([prev.path]); // old version removed only after the new one is live
  await svc.rpc("write_audit", { p_org: orgId, p_site: null as unknown as string, p_actor: user.id, p_action: "template.ticket_image", p_entity_type: "tenant_asset", p_entity_id: orgId, p_reason: null as unknown as string, p_meta: { version, bytes: out.data.length } });
  return ok({ version, width: out.info.width, height: out.info.height, bytes_original: file.size, bytes_optimized: out.data.length }, 201);
}

/** Serves the firm's own ticket image (never another firm's). */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const orgId = new URL(req.url).searchParams.get("organization_id") ?? "";
  if (!uuid.test(orgId)) return fail(400, "invalid_request", "Invalid organisation.");
  const [a, b] = await Promise.all([
    user.sb.rpc("has_permission", { org: orgId, perm: "print.view" }),
    user.sb.rpc("has_permission", { org: orgId, perm: "ticket.image" }),
  ]);
  if (!a.data && !b.data) return fail(403, "forbidden", "Not allowed.");
  const svc = serviceClient();
  const { data: asset } = await svc.from("tenant_assets").select("path,version").eq("organization_id", orgId).eq("kind", "ticket_preview").maybeSingle();
  if (!asset) return fail(404, "not_found", "No ticket image yet.");
  const dl = await svc.storage.from(BUCKET).download(asset.path);
  if (dl.error || !dl.data) return fail(404, "not_found", "No ticket image yet.");
  return new Response(await dl.data.arrayBuffer(), {
    headers: { "content-type": "image/webp", "cache-control": "private, max-age=86400", etag: `"v${asset.version}"`, "x-content-type-options": "nosniff" },
  });
}
