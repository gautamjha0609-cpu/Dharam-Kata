"use client";
import { createContext, useContext } from "react";

/** State the app shell shares with full-screen pages (e.g. the receipt layout editor). */
export const ShellUi = createContext<{ openMenu: () => void; immersive: boolean }>({ openMenu: () => {}, immersive: false });
/** For full-screen pages: open the navigation menu. */
export const useShell = () => useContext(ShellUi);
