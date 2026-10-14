"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Business, BusinessRecord } from "@/lib/businesses/contracts";

/**
 * David Edition's cinematic, data-driven space viewport.
 * Background pixels carry NO operational state. All selectable planets
 * are accessible DOM controls backed by the authorized business catalog.
 */
export function DavidUniverseScene({
  businesses, selectedId, satellites, onSelect
}: {
  businesses: readonly Business[];
  selectedId: string | null;
  satellites?: readonly BusinessRecord[];
  onSelect: (business: Business, button: HTMLButtonElement) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [motion, setMotion] = useState(true);
  const [focus, setFocus] = useState(false);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setMotion(!reducedMotion.matches);
    const change = () => setMotion(!reducedMotion.matches);
    reducedMotion.addEventListener("change", change);
    return () => reducedMotion.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext("2d", { alpha: false });
    if (!ctx) return;
    let frame = 0, clock = 0, width = 0, height = 0, dpr = 1;
    const rand = (n: number) => {
      const a = Math.sin(n * 127.1 + 92.3) * 43758.5453;
      return a - Math.floor(a);
    };
    const stars = Array.from({ length: 390 }, (_, i) => ({
      x: rand(i * 7 + 3), y: rand(i * 11 + 8),
      radius: .3 + rand(i * 13) * 1.25,
      alpha: .15 + rand(i * 19) * .8,
      depth: .2 + rand(i * 23),
      phase: rand(i * 17) * 6.28
    }));
    const resize = () => {
      const box = element.getBoundingClientRect();
      width = Math.max(1, box.width);
      height = Math.max(1, box.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const draw = () => {
      clock += motion ? .016 : 0;
      const background = ctx.createLinearGradient(0, 0, width, height);
      background.addColorStop(0, "#020611");
      background.addColorStop(.48, "#08162c");
      background.addColorStop(1, "#030816");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      // Multi-layer nebula and subtle stellar cloud; never used to imply health.
      for (const [x, y, radius, rgb, opacity] of [
        [.22,.35,.65,"39,73,134",.24],
        [.83,.22,.62,"87,53,134",.18],
        [.55,.88,.6,"10,100,145",.18],
        [.66,.52,.34,"140,98,60",.08]
      ] as const) {
        const g = ctx.createRadialGradient(width*x,height*y,0,width*x,height*y,Math.max(width,height)*radius);
        g.addColorStop(0,`rgba(${rgb},${opacity})`);
        g.addColorStop(1,`rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0,0,width,height);
      }
      for (const star of stars) {
        const x = (star.x * width + pointer.current.x * star.depth * 12 + width) % width;
        const y = (star.y * height + pointer.current.y * star.depth * 9 + height) % height;
        const alpha = star.alpha * (motion ? .81 + .19 * Math.sin(clock * star.depth + star.phase) : 1);
        ctx.fillStyle = `rgba(214,234,255,${alpha})`;
        ctx.beginPath(); ctx.arc(x,y,star.radius,0,Math.PI*2); ctx.fill();
      }
      const cx = width * .5, cy = height * .52;
      ctx.save();
      ctx.translate(cx,cy);
      const scale = Math.min(width/1000,height/700);
      ctx.rotate(-.36);
      for (const [radiusX,radiusY,alpha] of [[350,170,.19],[245,116,.21],[455,222,.12]] as const) {
        ctx.strokeStyle = `rgba(117,182,235,${alpha})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2,7]);
        ctx.beginPath();ctx.ellipse(0,0,radiusX*scale,radiusY*scale,0,0,Math.PI*2);ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
      if (motion) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [motion]);

  const visible = businesses.slice(0, 6);
  return <div className="de-cosmos" data-focused={focus} onPointerMove={event => {
    if (!motion || event.pointerType === "touch") return;
    const r = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX-r.left)/r.width*2-1;
    const y = (event.clientY-r.top)/r.height*2-1;
    // Avoid a state update per pointer pixel.
    pointer.current = { x, y };
  }}>
    <canvas className="de-cosmos-canvas" ref={canvas} aria-hidden="true"/>
    <div className="de-cosmos-vignette" aria-hidden="true"/>
    <div className="de-cosmos-topline"><span><span className="de-cosmos-live"/> AUTHENTICATED BUSINESS UNIVERSE</span><span>{businesses.length} BUSINESS{businesses.length===1?"":"ES"} · STATUS UNVERIFIED</span></div>
    <div className="de-cosmos-core" aria-hidden="true">
      <div className="de-cosmos-core-halo"/>
      <div className="de-cosmos-core-sphere"/>
      <div className="de-cosmos-core-label"><strong>GETDONE</strong><span>INTELLIGENCE CORE</span></div>
    </div>
    {visible.map((business, index) => {
      const angle = (-92 + index * 360 / Math.max(visible.length, 1)) * Math.PI/180;
      const spread = visible.length < 3 ? .34 : .38;
      const x = 50 + Math.cos(angle)*spread*100;
      const y = 52 + Math.sin(angle)*31;
      const hue = [201,28,172,275,42,223][index];
      return <button type="button" key={business.portfolioId}
        className="de-cosmos-planet" aria-label={`Inspect ${business.name}`}
        aria-pressed={selectedId===business.portfolioId}
        style={{ "--planet-x":`${x}%`, "--planet-y":`${y}%`, "--planet-hue":hue, "--planet-delay":`${index*-.8}s` } as CSSProperties}
        onClick={event => { setFocus(true); onSelect(business,event.currentTarget); }}>
        <span className="de-cosmos-sphere" aria-hidden="true"><span className="de-cosmos-atmosphere"/></span>
        <strong>{business.name}</strong>
        <small>{business.lastActivityAt ? "ACTIVITY RECORDED" : "NO ACTIVITY RECORDED"}</small>
      </button>;
    })}
    {selectedId && satellites && satellites.length > 0 ? <aside className="de-cosmos-satellites" aria-label="Selected business integrations"><span className="de-cosmos-satellites-label">CONNECTED RECORDS · {satellites.length} INTEGRATIONS</span>{satellites.slice(0, 4).map(item => <div key={item.id} className="de-cosmos-satellite"><span className="de-cosmos-satellite-dot" aria-hidden="true"/><span><strong>{item.title}</strong><small>{item.status.replaceAll("_", " ")}</small></span></div>)}</aside> : null}
    <div className="de-cosmos-bottomline"><span>SELECT A PLANET TO INSPECT ITS VERIFIED RECORDS</span><button type="button" aria-label={motion?"Pause space animation":"Resume space animation"} onClick={()=>setMotion(v=>!v)}>{motion?"PAUSE MOTION":"RESUME MOTION"}</button></div>
  </div>;
}
