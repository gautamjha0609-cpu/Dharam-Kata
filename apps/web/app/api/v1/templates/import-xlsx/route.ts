import { importLayoutFromXlsx } from "@dk/print-template/xlsx";
import { currentUser, fail, ok, rateLimit } from "@/lib/api";

const MAX_BYTES = 1_000_000;

/** Parses an uploaded Excel ticket template into a validated layout. The file is never stored. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  if (!rateLimit(`xlsx:${user.id}`, 20, 60_000)) return fail(429, "rate_limited", "Too many requests.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const orgId = String(form?.get("organization_id") ?? "");
  if (!(file instanceof File) || !/^[0-9a-f-]{36}$/i.test(orgId)) return fail(400, "invalid_request", "Choose an .xlsx file.");
  const { data: allowed } = await user.sb.rpc("has_permission", { org: orgId, perm: "template.manage" });
  if (!allowed) return fail(403, "forbidden", "You do not have permission to manage templates.");
  if (file.size > MAX_BYTES) return fail(413, "too_large", "The file is too large (max 1 MB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  // real signature check, not just the extension: .xlsx is a ZIP ("PK")
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return fail(415, "not_xlsx", "That is not a valid .xlsx file.");

  const paper = { w: Number(form?.get("paper_w") ?? 170), h: Number(form?.get("paper_h") ?? 95) };
  const area = { x: Number(form?.get("area_x") ?? 10), y: Number(form?.get("area_y") ?? 32), w: Number(form?.get("area_w") ?? 150), h: Number(form?.get("area_h") ?? 50) };
  try {
    const { layout, report } = await importLayoutFromXlsx(bytes, { paper, printArea: area, name: file.name.replace(/\.xlsx$/i, "") });
    return ok({ layout, report });
  } catch {
    return fail(422, "import_failed", "Could not read that template. Check paper/area sizes and that it has labels like Party, Vehicle, Loaded, Empty.");
  }
}
