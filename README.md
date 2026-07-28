# Jigsy's Old Forge Pizza — website concept

A redesign concept / practice template for **Jigsy's Brewpub & Restaurant**
(Old Forge–style pizza, Enola, PA). Single self-contained `index.html` plus a
small `images/` folder — no build step, no npm deps.

```
cd C:/development/projects/jigsys_site
python -m http.server 8080   # then visit http://localhost:8080
```

Live: https://jigsyssite.vercel.app  
Repo: https://github.com/nicholaswittle/jigsysite  

Online orders write to the shared Apex Supabase project and show up in the
staff console. Phone ordering remains available when the kitchen is paused.

## What's in it

- **Order ahead** — online pickup via Apex `place_order` (`ordering.js`,
  `public_token=jigsys`) plus phone fallback. Capacity banners pause/warn from
  `capacity_snapshot`. Static board menu stays for browsing.
- **Full-bleed photo hero** — venue collage from Jigsy's public graphics; Call
  is the primary CTA.
- **Real Nov 2025 menu** — Old Forge / Specialty / Gourmet / Wings / Stromboli /
  Starters / Salads / Subs, transcribed from published menu images.
- **Live Open/Closed** — Summer 2026 hours; hours table marks "today."
- Old Forge explainer (Red or White · By the Tray · Cut in Squares), story band,
  visit/location, sticky order bar, light/dark theme toggle.
- Document head + Open Graph + `Restaurant` JSON-LD.
- Motion respects `prefers-reduced-motion`; content visible with JS off.

## Photos

`images/` holds assets pulled from `jigsyspizza.com/graphics` for this concept:

| File | Use |
|------|-----|
| `banner_collage.png` | Hero + photo band (building / signage) |
| `img_2956.jpg` | Photo band + story (catering food) |
| `square-logo-full.png` | Favicon |

Tray / wings close-ups are still thin in the public graphics folder — swap in
fresher phone photos when available.

## Design tokens

Inline CSS custom properties in `index.html`: sauce red `#B23A2B`, golden-crust
`#CF9438`, charred anthracite `#17110D`, warm paper `#F7F0E3`.

## Deploy note

Vercel deploy under **wi-sense-llc** is currently CLI-based (not Git-integrated).
After changes: `vercel --cwd . deploy --prod --yes --scope wi-sense-llc`

This is a **concept**, not the official Jigsy's site.
