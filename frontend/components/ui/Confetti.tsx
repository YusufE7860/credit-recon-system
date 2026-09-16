'use client';

import { useEffect, useRef } from 'react';

// Dependency-free canvas confetti. Sprays a burst of colourful
// rectangles from the middle of the viewport, animates them with
// simple physics (gravity + air drag + spin), and clears itself
// once every piece has fallen off-screen.
//
// Fires once when `run` flips from false → true. Call it from a
// parent that toggles the flag when something worth celebrating
// happens (invoice matched, statement fully reconciled, etc.).
//
// The canvas is fixed to the viewport, pointer-events: none, so
// it never blocks clicks — even while the confetti is falling
// the user can carry on interacting with the underlying UI.

interface ConfettiProps {
  run: boolean;
  // How many pieces to spawn. 150 is the "big deal" default; drop
  // to 60 for a subtler celebration.
  pieces?: number;
  // Fired when the last piece has left the screen. Handy for the
  // parent to auto-close its congratulations modal.
  onDone?: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
  shape: 'rect' | 'circle';
}

// FFG-ish palette — orange as the hero, with fun accent hues so
// it doesn't feel monochrome.
const COLORS = [
  '#f97316', // brand orange
  '#fb923c',
  '#fbbf24', // amber
  '#22c55e', // green
  '#38bdf8', // sky
  '#a855f7', // violet
  '#ec4899', // pink
];

export default function Confetti({ run, pieces = 150, onDone }: ConfettiProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(onDone);

  // Keep the latest onDone handler in a ref so the animation loop
  // doesn't need to re-bind when the parent re-renders.
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!run) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match the canvas backing store to the device pixel ratio so
    // the confetti stays crisp on retina displays.
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Spawn the burst. Two sources — left-middle and right-middle,
    // aimed inward and upward — so the fan-out looks intentional
    // rather than a single geyser.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const parts: Particle[] = [];
    for (let i = 0; i < pieces; i++) {
      const fromLeft = i < pieces / 2;
      const originX = fromLeft ? width * 0.15 : width * 0.85;
      const originY = height * 0.6;
      // Base angle points inward + upward. Add a bit of jitter so
      // the burst has some spread.
      const baseAngle = fromLeft ? -Math.PI / 3 : (-Math.PI * 2) / 3;
      const angle = baseAngle + (Math.random() - 0.5) * (Math.PI / 3);
      const speed = 12 + Math.random() * 10;
      parts.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 7,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.35,
        shape: Math.random() > 0.35 ? 'rect' : 'circle',
      });
    }
    particlesRef.current = parts;

    // Physics constants — tuned to feel snappy but not silly.
    const GRAVITY = 0.35;
    const DRAG = 0.995;

    const step = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        p.vy += GRAVITY;
        p.vx *= DRAG;
        p.vy *= DRAG;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        if (p.y - p.size > h || p.x + p.size < 0 || p.x - p.size > w) {
          // Fell off-screen — drop it.
          continue;
        }
        alive.push(p);

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      particlesRef.current = alive;

      if (alive.length > 0) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        ctx.clearRect(0, 0, w, h);
        doneRef.current?.();
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      particlesRef.current = [];
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
  }, [run, pieces]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 pointer-events-none z-[70]"
    />
  );
}
