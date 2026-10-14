"use client";
import { useState } from "react";

/**
 * The only branding in the app: The Valuation House. No firm logos anywhere.
 *  - phones / portrait screens: the logo mark + the fixed name
 *  - desktop: the animated wordmark (letters appear once, then it stays still; only opacity/transform are animated, so it never janks)
 */

/** Logo mark (134x80 webp, ~5 KB). Width/height reserve the space so nothing jumps while it loads. */
export function ValuationMark({ height = 36, className = "" }: { height?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/valuation_logo.webp" alt="" aria-hidden width={Math.round((height * 134) / 80)} height={height} decoding="async" className={`shrink-0 object-contain ${className}`} style={{ height, width: "auto" }} />;
}

/**
 * Desktop brand: the logo-reveal animation (400x225, 90 frames, looping continuously, like the original GIF).
 * /brand/valuation_house.webp is the optimised copy of the supplied GIF (2.6 MB -> ~400 KB); people who asked their device for
 * "reduce motion" get the final frame as a still. If the file is missing the CSS wordmark is shown.
 */
const ANIM = { w: 400, h: 225 };
/** The animation has a grey vignette; fading all four edges to transparent lets it melt into whatever page colour is behind it. */
const FEATHER = (() => {
  const mask = "radial-gradient(ellipse 50% 50% at 50% 50%, #000 35%, rgba(0,0,0,0.5) 62%, transparent 100%)";
  return { WebkitMaskImage: mask, maskImage: mask } as const;
})();
/** `width` is a number (px) or any CSS length such as "min(340px, 48dvh)"; the height follows the 16:9 shape of the animation. */
export function ValuationDesktopBrand({ width = 240, fill = false, height, className = "" }: { width?: number | string; /** fill the whole width of the parent (the sidebar) and crop evenly instead of leaving a gap */ fill?: boolean; /** CSS height used with `fill`, e.g. "clamp(100px, 24dvh, 135px)" */ height?: string; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <ValuationWordmark fontSize={typeof width === "number" ? Math.round(width / 9.5) : 28} className={className} />;
  return (
    <picture role="img" aria-label="The Valuation House" className={`block shrink-0 ${className}`} style={fill ? { width: "100%", height: height ?? "135px" } : { width, ...(height ? { height } : { aspectRatio: `${ANIM.w} / ${ANIM.h}` }), ...FEATHER }}>
      <source media="(prefers-reduced-motion: reduce)" srcSet="/brand/valuation_house_end.webp" type="image/webp" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/valuation_house.webp" alt="" aria-hidden width={ANIM.w} height={ANIM.h} draggable={false} decoding="async" onError={() => setMissing(true)}
        className={`block h-full w-full select-none ${fill || height ? "object-cover object-center" : ""}`} />
    </picture>
  );
}

/**
 * Phone / portrait: the WHOLE logo, as on the brand artwork: the mark and the three-line name "The / Valuation / House" (Valuation in blue).
 * Real text (sharp at every size), never truncated: the name is laid out at a size tied to the mark, so the pair always fits side by side.
 */
export function ValuationBrandCompact({ size = 36, className = "" }: { size?: number; className?: string }) {
  const fs = Math.max(11, Math.round(size * 0.36));
  return (
    <span role="img" aria-label="The Valuation House" className={`flex items-center gap-1.5 ${className}`}>
      <ValuationMark height={size} />
      <span aria-hidden className="flex shrink-0 flex-col whitespace-nowrap font-bold" style={{ fontSize: fs, lineHeight: 1.02 }}>
        <span className="text-[#1c2a3a]">The</span>
        <span className="text-[#1f5ea8]">Valuation</span>
        <span className="text-[#1c2a3a]">House</span>
      </span>
    </span>
  );
}

const WORDS: { text: string; blue?: boolean }[] = [{ text: "The" }, { text: "Valuation", blue: true }, { text: "House" }];

/** Desktop: the wordmark writes itself in once (about 1.2 s) and then stays. Honours "reduce motion". */
export function ValuationWordmark({ className = "", fontSize = 24 }: { className?: string; fontSize?: number }) {
  let i = 0;
  return (
    <span role="img" aria-label="The Valuation House" className={`vh-wordmark inline-flex items-baseline gap-x-[0.28em] whitespace-nowrap ${className}`} style={{ fontSize }}>
      {WORDS.map((w) => (
        <span key={w.text} aria-hidden className={w.blue ? "text-[#1f5ea8]" : "text-[#1c2a3a]"}>
          {[...w.text].map((ch) => <span key={i} className="vh-letter" style={{ animationDelay: `${60 * i++}ms` }}>{ch}</span>)}
        </span>
      ))}
    </span>
  );
}
