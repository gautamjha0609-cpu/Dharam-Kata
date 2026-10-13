"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "./supabase";

export interface Membership {
  organization_id: string;
  display_name: string;
  status: string;
  role: "owner" | "admin" | "operator" | "accounts" | "remote_site";
  permissions: string[];
  site_ids: string[];
}
export interface Me {
  user_id: string;
  login_id: string;
  full_name: string;
  must_change_password: boolean;
  is_platform_admin: boolean;
  memberships: Membership[];
}
export interface Site {
  id: string;
  name: string;
  code: string;
}
export interface Settings {
  weight_unit: "kg" | "tonne" | null;
}

interface Ctx {
  me: Me;
  org: Membership | null;
  sites: Site[];
  settings: Settings;
  can: (perm: string) => boolean;
  selectOrg: (id: string) => void;
  refresh: () => Promise<void>;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const v = useContext(AppCtx);
  if (!v) throw new Error("useApp outside provider");
  return v;
};

const ORG_KEY = "dk.org";

export interface InitialApp { me: Me; orgId: string | null; sites: Site[]; settings: Settings }

/**
 * Holds who is signed in and which firm they are working in. The server hands over the first firm's data with the page
 * (see app/(app)/layout.tsx); only switching to another firm fetches more.
 */
export function AppProvider({ initial, children }: { initial: InitialApp; children: ReactNode }) {
  const me = initial.me;
  const [orgId, setOrgId] = useState<string | null>(initial.orgId);
  const [sites, setSites] = useState<Site[]>(initial.sites);
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const loadedFor = useRef<string | null>(initial.orgId); // the firm whose sites / billing unit are already here

  // a refreshed page brings fresh data for its firm
  useEffect(() => {
    if (orgId !== initial.orgId) return;
    setSites(initial.sites); setSettings(initial.settings); loadedFor.current = initial.orgId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // the firm this person used last (only matters with several firms); applied after hydration so server and browser agree on the first paint
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ORG_KEY);
      if (saved && saved !== orgId && me.memberships.some((m) => m.organization_id === saved)) setOrgId(saved);
    } catch {
      /* storage unavailable: stay on the first firm */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!orgId || orgId === loadedFor.current) return;
    let alive = true;
    const sb = supabase();
    void (async () => {
      const [s, p] = await Promise.all([
        sb.from("sites").select("id,name,code").eq("organization_id", orgId).eq("active", true).order("name"),
        sb.from("pricing_settings").select("weight_unit").eq("organization_id", orgId).maybeSingle(),
      ]);
      if (!alive) return;
      loadedFor.current = orgId;
      setSites((s.data ?? []) as Site[]);
      setSettings({ weight_unit: (p.data?.weight_unit as Settings["weight_unit"]) ?? null });
    })();
    return () => { alive = false; };
  }, [orgId]);

  const org = useMemo(() => me.memberships.find((m) => m.organization_id === orgId) ?? null, [me, orgId]);
  const value = useMemo<Ctx>(
    () => ({
      me,
      org,
      sites,
      settings,
      can: (p) => !!org?.permissions.includes(p),
      selectOrg: (id) => {
        try {
          localStorage.setItem(ORG_KEY, id);
        } catch {
          /* ignore */
        }
        setOrgId(id);
      },
      refresh: async () => {
        if (!orgId) return;
        const { data } = await supabase().from("pricing_settings").select("weight_unit").eq("organization_id", orgId).maybeSingle();
        setSettings({ weight_unit: (data?.weight_unit as Settings["weight_unit"]) ?? null });
      },
    }),
    [me, org, sites, settings, orgId],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
