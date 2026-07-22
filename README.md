# Jigsy's Old Forge Pizza — website concept

A redesign concept / practice template for **Jigsy's Brewpub & Restaurant**
(Old Forge–style pizza, Enola, PA). Built as a single self-contained
`index.html` — no build step, no dependencies, no external assets.

Open it by double-clicking `index.html`, or serve the folder:

```
cd C:/development/projects/jigsys_site
python -m http.server 8080   # then visit http://localhost:8080
```

## What's in it

- **Build Your Tray** — interactive: Red/White, Half/Full, live toppings;
  the SVG tray and price update in real time.
- **Live Open/Closed status** — computed from the real Summer 2026 hours;
  the hours table auto-marks "today".
- Old Forge explainer (Red or White · By the Tray · Cut in Squares),
  full sample menu, story band, visit/location, sticky order bar.
- Ambient oven-steam hero (canvas), diner-sign marquee, scroll-in reveals.
- Light + dark themes with a working toggle.
- All motion respects `prefers-reduced-motion`; progressive-enhancement
  safe (content is visible with JS disabled).

Design system lives inline in `index.html` as CSS custom properties
(`:root`): sauce red `#B23A2B`, golden-crust amber `#CF9438`, charred
anthracite `#17110D`, warm paper `#F7F0E3`. Type is a system grotesque
display paired with Georgia for body.

## Before this ships as a real site

This is a **concept**, not the official Jigsy's site. Two things to swap:

1. **Menu items and prices are placeholder samples.** Replace with the real
   menu. (The current live site keeps its menu behind a separate link.)
2. **It's photo-less.** The Artifact CSP blocked remote images, so the hero
   art is a CSS/SVG tray. A production site wants real food photography —
   add `<img>` slots or embed images as data URIs.

Real, verified details already in the page: address (225 N Enola Road,
Enola PA 17025), phone (717) 732-7708, the Summer 2026 hours, the 2023
Harrisburg Magazine "Best Wings" award, and the Instagram handle.

Published concept (private Artifact):
https://claude.ai/code/artifact/85f5d407-0824-480e-863b-dab0d6fedc65
