import { serviceClient } from "@/lib/supabase-server";

/** At most this many devices per user. A 3rd device is refused; devices already signed in are never touched. */
export const DEVICE_LIMIT = 2;
export const DEVICE_COOKIE = "dk_device_id";

export interface DeviceCheck { allowed: boolean; message?: string }

/** Records this device for the user, or refuses it when the user is already signed in on DEVICE_LIMIT other devices. */
export async function checkDeviceLogin(userId: string, deviceId: string, userAgent: string, ip: string): Promise<DeviceCheck> {
  const { data, error } = await serviceClient().rpc("device_login", { p_user: userId, p_device: deviceId, p_name: deviceName(userAgent), p_ip: ip, p_limit: DEVICE_LIMIT });
  // the check itself failing must never lock people out of their work: let the login through
  if (error || !data) return { allowed: true };
  const r = data as { allowed: boolean; devices?: { name: string }[] };
  if (r.allowed) return { allowed: true };
  const names = (r.devices ?? []).map((d) => d.name).join(" and ");
  return {
    allowed: false,
    message: `You are already logged in on ${DEVICE_LIMIT} devices${names ? ` (${names})` : ""}. Log out on one of them first, or ask your owner / administrator to sign you out of all devices.`,
  };
}

/** Logging out frees this device's slot. */
export async function releaseDevice(userId: string, deviceId: string) {
  await serviceClient().rpc("device_logout", { p_user: userId, p_device: deviceId });
}

function deviceName(ua: string): string {
  const os = /android/i.test(ua) ? "Android" : /iphone|ipad/i.test(ua) ? "iPhone / iPad" : /windows/i.test(ua) ? "Windows" : /mac os/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "";
  const br = /edg\//i.test(ua) ? "Edge" : /chrome|crios/i.test(ua) ? "Chrome" : /firefox|fxios/i.test(ua) ? "Firefox" : /safari/i.test(ua) ? "Safari" : "Browser";
  return os ? `${br} on ${os}` : br;
}
