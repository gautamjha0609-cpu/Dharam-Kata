"use client";
import { Select } from "@/components/ios";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "@/lib/app-context";
import { supabase } from "@/lib/supabase";
import { ShellUi } from "@/lib/shell-ui";
import { InstallApp } from "@/components/install-app";
import { UpdateBar } from "@/components/update-bar";
import { NoticeHost } from "@/components/notice-host";
import { ADMIN_PATH } from "@/lib/admin-path";
import { termState } from "@dk/domain";
import { ValuationBrandCompact, ValuationDesktopBrand, ValuationMark } from "@/components/valuation-brand";

interface NavItem { href: string; label: string; icon: string; show: (can: (p: string) => boolean, platform: boolean) => boolean; primary?: boolean }
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "▦", show: () => true, primary: true },
  { href: "/weighments/new", label: "New weighment", icon: "＋", show: (c) => c("weighment.create"), primary: true },
  { href: "/weighments", label: "Open entries", icon: "⚖", show: (c) => c("weighment.create") || c("weighment.complete"), primary: true },
  { href: "/invoices", label: "Invoices", icon: "▤", show: (c) => c("invoice.read"), primary: true },
  { href: "/reports", label: "Reports", icon: "▥", show: (c) => c("report.view") },
  { href: "/collections", label: "Collections", icon: "₹", show: (c) => c("payment.record") },
  { href: "/parties", label: "Debtors", icon: "◉", show: (c) => c("party.read") || c("party.manage") },
  { href: "/print", label: "Print centre", icon: "⎙", show: (c) => c("print.view") },
  { href: "/settings", label: "Settings", icon: "⚙", show: (c) => c("pricing.manage") || c("series.manage") || c("print.route.manage") || c("agent.remove") || c("template.manage") || c("ticket.image") },
  { href: ADMIN_PATH, label: "Platform admin", icon: "★", show: (_c, p) => p },
];

/** Pages that use the whole screen (the receipt layout editor) hide the header and bottom bar; the menu opens as a drawer. */
const IMMERSIVE = ["/settings/template"];

function useOnline() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(navigator.onLine);
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener("online", a);
    window.addEventListener("offline", b);
    return () => { window.removeEventListener("online", a); window.removeEventListener("offline", b); };
  }, []);
  return on;
}

/** The app frame: sidebar, header, bottom bar. Rendered inside AppProvider. */
export function Shell({ children }: { children: ReactNode }) {
  const { me, org, can, selectOrg } = useApp();
  const path = usePathname();
  const router = useRouter();
  const online = useOnline();
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const immersive = IMMERSIVE.some((p) => path === p || path.startsWith(p + "/"));
  const items = NAV.filter((n) => n.show(can, me.is_platform_admin));
  const matches = (h: string) => (h === "/" ? path === "/" : path === h || path.startsWith(h + "/"));
  const bestHref = [...NAV].filter((n) => matches(n.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const active = (h: string) => h === bestHref; // the longest matching link only, so /weighments/new does not also light up /weighments

  useEffect(() => { setMenu(false); setDrawer(false); }, [path]);
  useEffect(() => { try { setCollapsed(localStorage.getItem("dk.sidebar") === "closed"); } catch { /* storage unavailable: stay open */ } }, []);
  useEffect(() => {
    if (!drawer) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [drawer]);
  useEffect(() => {
    if (!org && me.is_platform_admin && !path.startsWith(ADMIN_PATH)) router.replace(ADMIN_PATH);
  }, [org, me.is_platform_admin, path, router]);

  function toggleSidebar() {
    setCollapsed((c) => {
      try { localStorage.setItem("dk.sidebar", c ? "open" : "closed"); } catch { /* ignore */ }
      return !c;
    });
  }
  async function signOut() {
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
    try { await supabase().auth.signOut({ scope: "local" }); } catch { /* ignore */ }
    router.replace("/login");
  }
  const ui = useMemo(() => ({ openMenu: () => setDrawer(true), immersive }), [immersive]);

  const expired = !!org && termState(org.service_until).kind === "expired";
  const suspended = !!org && !["trial", "active", "grace"].includes(org.status);

  const nav = (compact: boolean) => (
    <nav className="nav-scroll flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main">
      {items.map((n) => (
        <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} title={compact ? n.label : undefined}
          className={`flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-medium [@media(max-height:760px)]:min-h-[38px] ${compact ? "justify-center" : ""} ${active(n.href) ? "bg-brand-dark text-white" : "text-slate-200 hover:bg-navy-700"}`}>
          <span aria-hidden className="w-5 text-center">{n.icon}</span>{!compact && n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <ShellUi.Provider value={ui}>
      <UpdateBar />
      <NoticeHost />
      <div className={`${immersive ? "h-[100dvh] overflow-hidden" : "min-h-screen"} md:flex`}>
        {/* desktop sidebar: open, or a slim icon rail when collapsed (not on full-screen pages) */}
        {!immersive && (
          <aside aria-label="Sidebar" className={`sticky top-0 hidden h-screen shrink-0 flex-col bg-navy text-white transition-[width] duration-200 md:flex ${collapsed ? "w-[72px]" : "w-60"}`}>
            <div className={`shrink-0 bg-white ${collapsed ? "flex h-16 items-center justify-center border-b border-slate-200 px-2" : ""}`}>
              {collapsed ? <ValuationMark height={34} /> : <ValuationDesktopBrand fill height="clamp(104px, 24dvh, 135px)" />}
            </div>
            {nav(collapsed)}
          </aside>
        )}

        {/* drawer: full-screen pages (and the same menu on phones) */}
        {drawer && (
          <div className="fixed inset-0 z-[60]">
            <div className="ios-fade absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <aside role="dialog" aria-modal="true" aria-label="Menu" className="ios-drawer absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col bg-navy text-white shadow-2xl">
              <div className="flex items-center justify-between gap-2 bg-white p-3">
                <ValuationBrandCompact size={40} />
                <button className="btn-ghost !min-h-[40px] !px-3" onClick={() => setDrawer(false)} aria-label="Close menu">✕</button>
              </div>
              {nav(false)}
            </aside>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!immersive && (
            <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:h-16 md:py-0">
              <button className="hidden h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-300 text-navy hover:bg-slate-50 md:grid" onClick={toggleSidebar}
                aria-label={collapsed ? "Open the side menu" : "Close the side menu"} aria-expanded={!collapsed} title={collapsed ? "Open the side menu" : "Close the side menu"}>
                <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
              </button>
              <ValuationBrandCompact size={36} className="shrink-0 md:hidden" /><span className="flex-1 md:hidden" />
              <div className={`min-w-0 md:flex-1 ${me.memberships.length > 1 ? "" : "max-md:hidden"}`}>
                {me.memberships.length > 1 ? (
                  <Select aria-label="Organisation" className="field !min-h-[36px] max-w-xs" value={org?.organization_id} onChange={(e) => selectOrg(e.target.value)}>
                    {me.memberships.map((m) => <option key={m.organization_id} value={m.organization_id}>{m.display_name}</option>)}
                  </Select>
                ) : (
                  <p className="hidden truncate text-sm font-semibold text-navy md:block">{org?.display_name ?? "Platform"}</p>
                )}
              </div>
              <InstallApp className="hidden sm:inline-flex" />
              <div className="relative">
                <button className="btn-ghost !min-h-[36px] max-w-[112px] truncate whitespace-nowrap !px-3 md:max-w-none" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-haspopup="menu">
                  {me.full_name || me.login_id} ▾
                </button>
                {menu && (
                  <div role="menu" className="absolute right-0 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                    <p className="px-3 py-1 text-xs text-slate-600">{org?.role ?? "platform admin"}</p>
                    <button role="menuitem" className="flex min-h-[44px] w-full items-center rounded px-3 text-left text-sm hover:bg-slate-50" onClick={signOut}>Sign out</button>
                  </div>
                )}
              </div>
            </header>
          )}

          {!online && <div role="alert" className="bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900">You are offline. Nothing can be saved or invoiced until you reconnect.</div>}
          {suspended && <div role="alert" className="bg-red-100 px-4 py-2 text-sm font-medium text-red-800">This organisation is {org!.status}. Records are read-only. Contact your administrator.</div>}
          {!suspended && expired && <div role="alert" className="bg-red-100 px-4 py-2 text-sm font-medium text-red-800">Your annual maintenance has ended, so your ID is suspended. Records are read-only until it is renewed. Please contact The Valuation House.</div>}

          {immersive ? (
            <main className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto lg:overflow-hidden">{children}</main>
          ) : (
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 pb-28 md:pb-8">{children}</main>
          )}

          {!immersive && (
            <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
              style={{ gridTemplateColumns: `repeat(${Math.min(items.filter((i) => i.primary).length + 1, 5)}, minmax(0, 1fr))` }}>
              {items.filter((i) => i.primary).map((n) => (
                <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}
                  className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active(n.href) ? "text-brand-dark" : "text-slate-600"}`}>
                  <span aria-hidden className="text-lg leading-none">{n.icon}</span>{n.label.replace("New weighment", "New")}
                </Link>
              ))}
              <MoreMenu items={items.filter((i) => !i.primary)} active={active} />
            </nav>
          )}
        </div>
      </div>
    </ShellUi.Provider>
  );
}

function MoreMenu({ items, active }: { items: NavItem[]; active: (h: string) => boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-600" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden className="text-lg leading-none">☰</span>More
      </button>
      {open && (
        <div className="absolute bottom-full right-1 mb-2 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {items.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
              className={`flex min-h-[44px] items-center gap-3 rounded px-3 text-sm ${active(n.href) ? "bg-brand-50 font-semibold text-brand-dark" : "text-navy"}`}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
